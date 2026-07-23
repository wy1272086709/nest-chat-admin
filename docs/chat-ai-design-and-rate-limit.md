# 聊天 AI 功能设计、Token 统计与频率限制

本文说明当前聊天 AI 功能的运行流程、模型适配、数据边界、Token 用量记录以及 Redis 频率限制。运行时代码以 `src/chat/moderation/chat-ai.service.ts` 为准。

## 1. 功能范围

当前提供两个需要登录的房间级 HTTP 接口：

| 功能 | 接口 | 内部标识 |
| --- | --- | --- |
| 聊天总结 | `POST /api/chat/rooms/:roomId/ai/summary` | `summary` |
| 回复建议 | `POST /api/chat/rooms/:roomId/ai/reply-suggestions` | `reply` |

聊天总结返回摘要、关键要点和待办事项。回复建议根据聊天记录和可选草稿生成最多 5 条候选回复，但不会代替用户发送消息。

## 2. 一次请求的处理流程

请求依次经过以下步骤：

1. 全局 JWT Guard 校验登录状态，Controller 从认证信息取得 `userId`。
2. `assertRoomMember` 校验用户是该房间的有效成员。无权限时直接拒绝，也不会占用 AI 限流额度。
3. Redis 按用户、房间和功能检查频率限制。超过限制返回 HTTP 429。
4. 查询最近的有效聊天消息，排除软删除消息以及用户清空时间之前的消息。
5. 最多读取 100 条消息，并按照 `AI_MAX_INPUT_CHARACTERS` 限制总字符数。
6. 将消息恢复为时间正序，只保留发送者显示名、发送时间、消息类型和文本内容。文件及媒体消息只传文件名。
7. 根据 `AI_API_MODE` 和模型选择 Responses API 或 Chat Completions API。
8. 解析供应商返回的 JSON，校验总结或回复建议的数据结构。
9. 把 Token 用量、耗时和状态写入日志及 `ai_usage_logs` 表，然后向客户端返回结果。

如果房间没有可用消息，接口直接返回空结果和全 0 的 `usage`，不会调用模型，也不会写入 `ai_usage_logs`。不过当前限流检查发生在读取消息之前，因此该请求仍会占用一次频率额度。

## 3. 模型调用设计

### 3.1 API 模式

`AI_API_MODE` 支持：

| 值 | 行为 |
| --- | --- |
| `responses` | 调用 `/responses`，使用 JSON Schema 结构化输出 |
| `chat-completions` | 调用 `/chat/completions`，使用 JSON Object 输出 |
| `auto` | `qwen-coder*` 使用 Chat Completions，其他模型使用 Responses |

模型凭据只从服务端环境变量读取。Responses 请求设置 `store: false`。

### 3.2 Prompt 与数据安全

系统 Prompt 将聊天记录和草稿声明为不可信数据，明确禁止执行其中的命令、链接和工具调用。后端不会把文件二进制、内部存储字段或完整业务对象发送给模型。

模型返回 JSON 后仍会在服务端校验字段类型：

- 总结必须包含字符串 `summary`、字符串数组 `keyPoints` 和字符串数组 `actionItems`。
- 回复建议必须包含字符串数组 `suggestions`，且最多 5 条。

供应商返回空内容、拒绝回答或数据格式错误时，接口返回 HTTP 502。

## 4. Token 用量统计

### 4.1 字段含义

接口响应和数据库使用统一字段：

| 字段 | 含义 | 供应商字段兼容 |
| --- | --- | --- |
| `inputTokens` | 输入给模型的 Token 数 | `input_tokens` 或 `prompt_tokens` |
| `outputTokens` | 模型生成的 Token 数 | `output_tokens` 或 `completion_tokens` |
| `totalTokens` | 输入与输出 Token 总数 | 优先使用 `total_tokens`，缺失时相加 |

Token 数以模型供应商返回值为准，服务端不自行估算。供应商没有返回用量，或者请求在获得响应前超时时，相应字段记为 0。

### 4.2 用量表

每次实际进入模型调用的请求都会写入 `ai_usage_logs`：

| 字段 | 说明 |
| --- | --- |
| `userId`、`roomId` | 调用用户和目标房间 |
| `feature` | `summary` 或 `reply` |
| `model` | 实际配置的模型名 |
| `inputTokens`、`outputTokens`、`totalTokens` | 供应商返回的 Token 用量 |
| `durationMs` | 从业务方法开始到记录用量时的耗时 |
| `statusCode` | 供应商或转换后的业务 HTTP 状态码 |
| `createdAt` | 记录创建时间 |

成功和失败的模型调用都会记录。用量写库失败只记录错误日志，不会覆盖已经生成的 AI 结果，也不会在表中保存 Prompt、草稿或聊天正文。

当前实现提供的是逐次调用明细，还没有管理端聚合报表、费用换算、用户日/月 Token 配额或预算熔断。这些属于后续运营能力，不能由当前频率限制替代。

## 5. Redis 频率限制

### 5.1 限流维度

Redis Key 格式为：

```text
rate-limit:chat-ai:{userId}:{roomId}:{feature}
```

因此以下场景分别计数：

- 同一用户在不同房间的请求。
- 同一房间内不同用户的请求。
- 同一用户、同一房间的总结和回复建议请求。

限流数据放在 Redis 中，所有应用实例共享，不会因为负载均衡到另一台服务而绕过限制。

### 5.2 配置

```dotenv
AI_RATE_LIMIT_WINDOW_MS=5000
AI_RATE_LIMIT_MAX_REQUESTS=1
```

默认含义是：同一用户、房间和功能在固定的 5000 毫秒窗口内最多通过 1 次请求。`AI_RATE_LIMIT_WINDOW_MS=0` 会关闭 AI 业务限流；最大请求数必须至少为 1。

例如，若希望 1 分钟最多请求 10 次：

```dotenv
AI_RATE_LIMIT_WINDOW_MS=60000
AI_RATE_LIMIT_MAX_REQUESTS=10
```

修改环境变量后需要重启服务才能生效。

### 5.3 Lua 代码含义

限流通过一段 Redis Lua 脚本原子执行：

```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
```

逐行含义如下：

1. `INCR` 将当前 Key 的请求次数加 1；Key 不存在时从 0 开始，因此第一次结果是 1。
2. 只有第一次请求会通过 `PEXPIRE` 设置毫秒级过期时间，形成一个固定窗口。
3. 返回递增后的次数，Node.js 代码将其与 `AI_RATE_LIMIT_MAX_REQUESTS` 比较。
4. 当 `count > maxRequests` 时返回 HTTP 429，不读取消息，也不调用模型。

使用 Lua 的原因是让“计数加一”和“首次设置过期时间”在 Redis 中作为一个原子操作执行。否则并发请求可能造成计数存在但没有过期时间，形成无法自动释放的限流 Key。

这是固定窗口算法，不是滑动窗口或令牌桶。窗口内被 429 拒绝的请求仍会继续增加计数，但不会延长原窗口的过期时间；窗口到期后 Key 自动删除，下一个请求重新从 1 开始。

## 6. 错误行为

| 场景 | HTTP 状态 | 是否调用模型 | 是否写用量表 |
| --- | --- | --- | --- |
| 未登录或 Token 无效 | 401 | 否 | 否 |
| 不是有效房间成员 | 403 | 否 | 否 |
| 触发本地 Redis 限流 | 429 | 否 | 否 |
| 未配置模型 API Key | 503 | 否 | 否 |
| 模型供应商返回 429 | 429 | 是 | 是 |
| 模型超时 | 504 | 是 | 是，Token 通常为 0 |
| 模型服务错误或格式错误 | 502 | 是 | 是 |

Redis 是当前限流链路的必要依赖。Redis 操作异常时请求不会绕过限流继续产生模型费用，而是由全局异常处理返回服务错误。

## 7. 运维检查

数据库迁移部署后，可以按用户查看近期调用：

```sql
SELECT "feature", "model", "inputTokens", "outputTokens", "totalTokens",
       "durationMs", "statusCode", "createdAt"
FROM "ai_usage_logs"
WHERE "userId" = '<user-id>'
ORDER BY "createdAt" DESC
LIMIT 100;
```

按天汇总总 Token：

```sql
SELECT date_trunc('day', "createdAt") AS day,
       "feature",
       SUM("inputTokens") AS input_tokens,
       SUM("outputTokens") AS output_tokens,
       SUM("totalTokens") AS total_tokens,
       COUNT(*) AS request_count
FROM "ai_usage_logs"
GROUP BY day, "feature"
ORDER BY day DESC, "feature";
```

调整限制时应同时观察请求量、429 比例、模型延迟和 Token 消耗。频率限制只控制调用次数，不能阻止单次超长请求；单次输入规模由消息数上限和 `AI_MAX_INPUT_CHARACTERS` 共同控制。
