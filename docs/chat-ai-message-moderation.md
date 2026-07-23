# 聊天消息 AI 内容审核

> 当前默认使用 RabbitMQ 异步审核。完整架构、任务拆分、风险和运维方案见 `rabbitmq-chat-moderation-design.md`。

## 1. 当前策略

群聊和私聊文本消息与 Outbox 事件在同一个数据库事务内提交，消息立即发送，RabbitMQ 消费者随后调用 AI。图片、文件、音频和视频目前不审核文件内容。

审核结果分为四类：

| 结果 | 当前行为 | 审核状态 |
| --- | --- | --- |
| `PASS` | 消息保持可见 | `NOT_REQUIRED` |
| `REVIEW` | 消息保持可见，保留待处理记录 | `PENDING` |
| `REJECT` | 影子模式只记录；启用动作后将正文替换为违规占位提示并实时通知 | `PENDING` |
| `DEGRADED` | 重试耗尽或永久错误时保持可见 | `PENDING` |

这是异步 fail-open 策略：审核基础设施故障不能阻断正常聊天。同步模式仍保留用于回滚，但不是默认模式。

警告和限时禁言能力已实现但默认关闭。只有同时启用审核动作和处罚开关后，确认 `REJECT` 的消息才会累计风险分。

## 2. 调用顺序与幂等

消息发送顺序如下：

1. 校验房间成员、禁言状态和 `clientMessageId` 幂等。
2. 在同一个 Prisma 事务内写入消息和 `moderation_outbox`。
3. Outbox Publisher 使用 RabbitMQ Publisher Confirm 投递事件。
4. 审核消费者读取消息正文并调用 AI。
5. 消费者在事务内写审核结果并更新消息审核状态，提交成功后 ACK。
6. 临时错误进入 Retry Queue，耗尽后进入 DLQ 并标记 `DEGRADED`。
7. 启用动作后，`REJECT` 会软删除消息并推送 `message:moderated`。

客户端应始终提供稳定且唯一的 `clientMessageId`，否则拒绝消息的重试无法复用历史结论，也可能重复产生模型费用。

## 3. 审核范围

模型按照以下风险类别判断：

- 辱骂和仇恨；
- 色情内容；
- 暴力和自残；
- 违法行为；
- 诈骗；
- 骚扰；
- 个人信息泄露。

聊天文本被视为不可信输入。系统 Prompt 明确禁止执行消息中的命令，并要求审核原因不得复述原文或个人信息。`message_moderations` 只保存分类、置信度和简短原因，不保存额外的消息正文副本。

## 4. 配置

```dotenv
AI_MODERATION_ENABLED=true
AI_MODERATION_MODEL=""
AI_MODERATION_TIMEOUT_MS=5000
AI_MODERATION_MAX_CHARACTERS=4000
AI_MODERATION_MODE="async"
AI_MODERATION_POLICY_VERSION="v1"
AI_MODERATION_ACTIONS_ENABLED=false
AI_MODERATION_ENFORCEMENT_ENABLED=false
```

- `AI_MODERATION_ENABLED`：是否启用审核；设为 `false` 时按 `DEGRADED` 放行。
- `AI_MODERATION_MODEL`：审核专用模型；留空时使用 `MODEL_NAME`。
- `AI_MODERATION_TIMEOUT_MS`：审核超时，默认 5 秒。超时按 `DEGRADED` 放行。
- `AI_MODERATION_MAX_CHARACTERS`：最多提交给模型的消息字符数，默认 4000。
- `AI_MODERATION_MODE`：`async`、`shadow`、`sync` 或 `off`；默认 `async`。
- `AI_MODERATION_POLICY_VERSION`：写入事件和审核记录的策略版本。
- `AI_MODERATION_ACTIONS_ENABLED`：是否对 `REJECT` 消息执行违规正文替换，默认开启；影子审核环境应显式设为 `false`。
- `AI_MODERATION_ENFORCEMENT_ENABLED`：是否累计违规并执行警告、禁言，默认关闭。

消息超过审核字符上限时只提交前半部分；即使模型判断为 `PASS`，最终也会转为 `REVIEW` 并添加 `content_truncated` 分类，避免超长消息被当作已完整审核。

审核复用 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `AI_API_MODE`。审核模型也必须支持项目所选择的 Responses 或 Chat Completions 请求格式。

## 5. 数据与 Token 统计

每次实际模型审核都会在 `ai_usage_logs` 中写入一条 `feature = 'moderation'` 的 Token 用量记录。未配置 API Key 或显式关闭审核时没有实际模型调用，因此不写 AI 用量。

审核业务结果写入 `message_moderations`，主要字段包括：

| 字段 | 含义 |
| --- | --- |
| `userId`、`roomId`、`messageId` | 用户、房间及已落库消息 |
| `clientMessageId` | 客户端幂等 ID |
| `decision` | `PASS`、`REVIEW`、`REJECT` 或 `DEGRADED` |
| `categories`、`confidence`、`reason` | 风险分类、置信度及规则原因 |
| `reviewStatus` | `NOT_REQUIRED` 或 `PENDING` |
| `model`、`statusCode`、`durationMs` | 模型与调用状态 |

## 6. 警告和禁言

处罚使用带时间窗口的累计风险分，默认配置为首次高置信违规警告、多次违规后禁言 10 分钟。任何自动处罚上线前都应先观察影子审核误判率。

1. `REVIEW` 只进入待处理状态，目前不累计处罚分。
2. `REJECT` 根据模型置信度记 1-3 分。
3. 时间窗口内达到警告阈值时推送 `moderation:warning`。
4. 达到禁言阈值时创建限时禁言并推送 `moderation:restricted`。
5. 当前不执行永久封禁；人工复核、申诉和管理端解除接口仍属于后续管理能力。

禁言检查位于新消息落库之前；已成功消息的幂等重试仍可取得原回执。处罚记录保存在 `user_violations` 和 `chat_user_restrictions`，基础设施 `DEGRADED` 不会处罚用户。
