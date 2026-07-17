# RabbitMQ 聊天消息 AI 异步审核设计

## 1. 文档状态与目标

本文描述聊天消息审核从“发送链路同步调用 AI”迁移到“消息先落库和推送，RabbitMQ 消费者异步审核”的目标设计及实施任务。

本文设计的 Outbox、Publisher Confirm、独立消费者 Channel、Retry/DLQ、异步 AI 消费者、撤回和限时禁言能力已经实现。自动撤回和处罚默认关闭，生产环境应按本文灰度顺序启用。

目标如下：

- AI 延迟或故障不阻塞正常聊天发送。
- 审核消费者可以独立扩容，并能继续增加规则审核、AI 审核和人工审核消费者。
- 使用至少一次投递和业务幂等，避免消息漏审或重复产生 AI 费用。
- 支持审核后撤回、风险累计、警告、限时禁言和人工复核。
- 保留 Token 用量、失败重试、死信和完整审计能力。

非目标：

- 第一阶段不审核图片、音视频或文件二进制。
- 第一阶段不自动永久封禁用户。
- RabbitMQ 不保证 AI 推理本身更快，只负责降低发送主链路延迟并提高审核吞吐能力。

## 2. 设计取舍

### 2.1 选择异步 fail-open

消息完成权限、禁言和本地确定性规则检查后立即落库并推送，AI 在消费者中异步执行。AI 不可用时消息仍可发送，审核任务进入重试或死信流程。

收益：

- 用户发送延迟不再包含模型响应时间。
- AI 故障不会拖垮聊天主链路。
- 消费者可以单独配置并发和扩容。

代价：

- 违规消息可能短暂可见，审核完成后才能撤回。
- 必须增加客户端 `message:moderated` 事件处理。
- 必须建设重试、DLQ、积压告警和人工补偿流程。

### 2.2 选择数据库 Outbox

不采用“消息落库后直接 publish”的双写方式。消息和 Outbox 事件在同一个 PostgreSQL 事务内提交，由独立 Publisher 异步投递 RabbitMQ。

原因：

- 数据库成功、RabbitMQ 失败会造成永久漏审。
- RabbitMQ 成功、数据库失败会让消费者查询不到消息。
- Outbox 可以在进程重启后继续投递，并提供可查询的发布状态。

代价是增加一张表、一个轮询 Publisher 和清理任务。当前业务量下轮询比引入 CDC 更简单；未来吞吐量明显增长时再评估 Debezium 等 CDC 方案。

### 2.3 事件只传标识，不传正文

RabbitMQ 事件只包含 `messageId`、`userId`、`roomId` 等标识，消费者按 `messageId` 从 PostgreSQL 读取正文。

收益是减少聊天正文进入 Broker 磁盘、死信和运维导出文件的范围。代价是消费者每次增加一次数据库查询。当前项目优先选择隐私边界清晰，而不是省略一次查询。

### 2.4 同一 Queue 竞争消费

多个 AI 审核实例消费同一个 Queue，以竞争消费者方式横向扩容。不能为每个实例创建 Queue，否则一条消息会被所有实例重复审核和计费。

如果未来增加不同职责的消费者，应为每类职责创建独立 Routing Key 或 Queue，例如规则审核和 AI 审核分别订阅各自事件，而不是复用同一个业务结果表互相覆盖。

### 2.5 本地规则与 AI 分层

推荐在发送主链路保留轻量、高确定性的本地规则：禁言检查、长度限制和极少量明确禁词。AI 负责依赖上下文的辱骂、色情、暴力、诈骗等语义审核。

本地规则必须控制误杀率，不能维护一个无法解释的大型词表。模型结论也不能直接触发永久封禁。

## 3. 总体流程

```text
Socket.IO message:sendRoom / message:sendPrivate
  -> JWT 和房间成员校验
  -> 禁言状态检查
  -> clientMessageId 幂等检查
  -> 本地确定性规则检查
  -> PostgreSQL 事务
       -> INSERT chat_messages (moderationStatus=PENDING)
       -> INSERT moderation_outbox (status=PENDING)
  -> 推送 message:new
  -> 返回发送成功

Outbox Publisher
  -> 锁定一批 PENDING/RETRY Outbox
  -> publish app.events / chat.moderation.requested
  -> Broker confirm 成功后标记 PUBLISHED

Moderation Consumer
  -> 校验事件结构和版本
  -> 查询消息及已有最终审核结果
  -> 调用 AI 并记录 ai_usage_logs
  -> 事务写 message_moderations + 更新 Message.moderationStatus
  -> PASS: ACK
  -> REVIEW: ACK，进入人工或规则处理
  -> REJECT: ACK，软删除/隐藏并发布审核结果事件
  -> 临时错误: 发布 retry 后 ACK 原消息
  -> 重试耗尽: 发布 DLQ，标记 DEGRADED 后 ACK 原消息

Moderation Action
  -> 广播 message:moderated
  -> 累计用户风险事件
  -> 根据规则警告、限时禁言或转人工
```

## 4. RabbitMQ 拓扑

审核复用现有固定 Topic Exchange，不把拓扑名称放进环境变量：

```ts
export const CHAT_MODERATION_TOPOLOGY = {
  queue: 'chat.moderation.requested.queue',
  retryQueue: 'chat.moderation.requested.retry.queue',
  deadLetterQueue: 'chat.moderation.requested.dlq',
  routingKey: 'chat.moderation.requested',
  retryRoutingKey: 'chat.moderation.requested.retry',
  deadLetterRoutingKey: 'chat.moderation.requested.dlq',
} as const;
```

建议第一版参数：

| 参数 | 建议值 | 说明 |
| --- | ---: | --- |
| Consumer Prefetch | 5 | 单实例最多同时持有 5 条未 ACK 消息 |
| AI Consumer 并发 | 2-5 | 受模型供应商并发限制约束 |
| 最大重试次数 | 3 | 不包含首次消费 |
| 重试延迟 | 10 秒、30 秒、120 秒 | 推荐分级延迟；现有单一 TTL 可先实现固定延迟 |
| 消息持久化 | 开启 | Queue durable，消息 persistent |
| DLQ | 独立 Queue | 禁止和邮件 DLQ 混用 |

注意：AMQP Channel 上的 `prefetch` 作用范围需要核对。当前 `RabbitmqService` 复用一个 Channel，邮件消费者与审核消费者可能互相影响。目标实现应为不同消费者创建独立 Channel，或者明确设置 per-consumer QoS，避免审核 Prefetch 改变邮件消费行为。

## 5. 事件契约

```ts
type MessageModerationRequestedV1 = {
  eventId: string;
  eventType: 'chat.moderation.requested';
  version: 1;
  messageId: string;
  userId: string;
  roomId: string;
  requestedAt: string;
  policyVersion: string;
};
```

约束：

- `eventId` 是 Outbox 主键或稳定 UUID，重投时保持不变。
- `messageId` 指向已经提交的消息。
- 不携带聊天正文、API Key、用户 Token、文件 URL 或内部存储信息。
- `version` 用于消费者兼容升级，未知版本进入隔离或 DLQ，不能按 V1 猜测解析。
- `policyVersion` 固化审核规则版本，便于解释历史结论。

RabbitMQ Header 保存 `x-attempts` 和最近一次非敏感错误类型。不得把模型响应正文、聊天正文或堆栈放入 Header。

## 6. 数据模型

### 6.1 Message

建议增加：

```text
moderationStatus: PENDING | PASSED | REVIEW | REJECTED | DEGRADED
moderatedAt: DateTime?
```

数据库默认值为 `PENDING`。非文本消息第一阶段可以直接设为 `PASSED`，或使用 `NOT_APPLICABLE` 枚举避免语义混淆。

### 6.2 ModerationOutbox

```text
id
eventType
aggregateId        # messageId
payload            # 只保存事件标识字段
status             # PENDING / PUBLISHING / PUBLISHED / RETRY / FAILED
attempts
nextAttemptAt
lockedAt
lockedBy
publishedAt
lastErrorCode
createdAt
updatedAt
```

必要索引：

- `(status, nextAttemptAt, createdAt)` 用于 Publisher 扫描。
- `(lockedAt)` 用于恢复超时锁。
- `aggregateId + eventType` 唯一约束，保证一条消息只生成一个审核请求。

Publisher 使用 `FOR UPDATE SKIP LOCKED` 或 Prisma 支持范围内的等价原子抢占，允许多个 Publisher 实例并行工作。

### 6.3 MessageModeration

沿用当前 `message_moderations`，但异步改造时应增加或调整：

```text
eventId
policyVersion
decision
reviewStatus
categories
confidence
reason
model
statusCode
durationMs
createdAt
```

建议对 `messageId` 建唯一约束，表示一条消息只有一个当前审核结论。如果需要保留重新审核历史，则拆成：

- `MessageModeration`：当前结论，每条消息唯一。
- `MessageModerationAttempt`：每次模型调用和重试明细。

不能直接允许多条结果并在查询时取“最新一条”，否则并发消费者可能以旧结果覆盖新结果。

### 6.4 用户处罚

后续增加：

```text
UserViolation
  id, userId, messageId, moderationId, category, severity,
  score, policyVersion, createdAt

ChatUserRestriction
  id, userId, type, startsAt, expiresAt, reason,
  sourceModerationId, status, createdAt, updatedAt
```

发送消息时同步查询有效 `ChatUserRestriction`。高流量后可以在 Redis 缓存禁言状态，但 PostgreSQL 仍是事实来源。

## 7. 一致性和幂等

RabbitMQ 提供至少一次投递，重复是正常情况，不应视为异常。

消费者处理规则：

1. 解析和校验事件，拒绝未知版本。
2. 若消息不存在或已物理删除，记录 `SKIPPED` 并 ACK。
3. 若 `messageId` 已存在最终结果，直接 ACK，不再次调用 AI。
4. 调用 AI 时记录 `eventId`，写结果使用唯一约束防并发重复。
5. 数据库结果提交成功后才能 ACK。
6. 若提交成功但 ACK 前连接断开，重新投递会在第 3 步被幂等跳过。

Outbox Publisher 也必须允许重复发布。Broker confirm 成功但数据库更新 `PUBLISHED` 失败时，事件会再次发布；消费者幂等负责消除副作用。

警告、撤回通知和禁言同样需要幂等键，例如 `moderationId + actionType`，避免重复通知或重复延长禁言时间。

## 8. 重试与错误分类

只重试临时错误：

- AI 请求超时、网络错误；
- 供应商 HTTP 429；
- 供应商 HTTP 5xx；
- 暂时性数据库或 RabbitMQ 连接错误。

不重试永久错误：

- 事件 JSON 或版本非法；
- 消息不存在；
- 模型配置不支持当前 API 模式；
- 模型持续返回无法解析的结构，超过一次格式修复机会后进入 DLQ。

重试时不得修改 `eventId`。每次实际 AI 调用都写 Token 用量；因此重试会产生额外费用，监控必须区分业务消息数和模型调用次数。

达到最大次数后：

1. 发布到审核 DLQ。
2. 将消息状态更新为 `DEGRADED`。
3. 写入待处理审核记录。
4. ACK 原队列消息。
5. 触发 DLQ 告警，由运维修复后选择重放。

如果发布 Retry 或 DLQ 失败，应 `nack(requeue=true)` 原消息，不能 ACK 后丢失。

## 9. 审核后动作

### PASS

- 更新为 `PASSED`。
- 不向普通客户端推送额外事件。

### REVIEW

- 更新为 `REVIEW`。
- 暂不自动处罚，进入人工队列或累计低权重风险分。
- 可向发送者发送私有警告，但第一阶段建议仅记录。

### REJECT

- 更新为 `REJECTED` 并软删除或设置独立的可见性状态。
- 广播 `message:moderated`：

```json
{
  "messageId": "...",
  "roomId": "...",
  "status": "REJECTED"
}
```

- 客户端将正文替换为统一的违规占位文案，不显示模型原因和分类。
- 创建 `UserViolation`，再由策略服务决定警告或禁言。

服务端历史查询、同步接口和收藏快照都必须遵守审核可见性，不能只依赖实时撤回事件，否则离线客户端重新同步后仍可能看到违规正文。

### DEGRADED

- 消息保持可见。
- 记录降级原因并进入运维待处理列表。
- 不因基础设施故障处罚用户。

## 10. 风险点

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 数据库成功但 MQ 发布失败 | 消息漏审 | 使用事务 Outbox，持续补投 |
| 重复投递或 ACK 丢失 | 重复 AI 费用、重复处罚 | `eventId`、`messageId` 唯一约束和动作幂等 |
| AI 审核积压 | 违规内容可见时间变长 | Lag 告警、消费者扩容、供应商降级策略 |
| 供应商限流或故障 | 大量重试和额外费用 | 指数退避、并发上限、熔断、DLQ |
| 违规消息已推送 | 短暂暴露 | 本地高置信规则、审核后软删除、实时撤回 |
| 客户端不处理撤回事件 | 违规内容持续显示 | 协议版本管理，历史/同步接口服务端过滤 |
| 模型误判 | 用户体验和处罚争议 | REVIEW/人工复核、规则版本、申诉、禁止自动永久封禁 |
| Prompt 注入 | 审核规则被消息改变 | 固定系统 Prompt、结构化输出、服务端结果校验 |
| 超长文本截断 | 尾部风险未审核 | 标记 REVIEW、分片审核或限制消息长度 |
| RabbitMQ 保存隐私数据 | 数据泄露范围扩大 | 事件不带正文，日志/Header 不记录正文 |
| Outbox 无限增长 | 数据库膨胀 | 分批清理已发布历史，保留审计周期 |
| DLQ 无人处理 | 实际形成永久漏审 | DLQ 非空告警、重放手册和责任人 |
| 邮件和审核共用 Channel | Prefetch 和故障互相影响 | 独立 Channel，分别配置 QoS |
| 多消费者更新乱序 | 旧结果覆盖新结果 | 版本/尝试号条件更新，当前结果唯一约束 |
| 禁言缓存不一致 | 已禁言用户仍能发送 | 数据库事实源、短 TTL、处罚时主动失效缓存 |

## 11. 运维注意事项

Connection、Publisher Channel、Consumer Channel 的恢复因果链和邮件消费者故障复盘见 [rabbitmq-consumer-recovery-retrospective.md](./rabbitmq-consumer-recovery-retrospective.md)。

### 11.1 必须监控

- 主队列 ready、unacked 数量和最老消息年龄。
- Retry Queue 和 DLQ 消息数量。
- Outbox `PENDING/RETRY` 数量及最老记录年龄。
- Publisher 发布成功率、confirm 延迟和连续失败次数。
- AI 审核吞吐、P50/P95/P99 延迟、429、5xx、超时比例。
- `PASS/REVIEW/REJECT/DEGRADED` 比例及突变。
- 每条业务消息平均模型调用次数和 Token 成本。
- Consumer 进程存活、重连次数、内存和事件循环延迟。

建议告警基线需要根据实际流量校准，初始可以设置：

- 审核最老消息年龄超过 60 秒告警，超过 5 分钟严重告警。
- DLQ 非空立即告警。
- 10 分钟内 `DEGRADED` 比例超过 5% 告警。
- 模型 429 或 5xx 连续 5 分钟超过 10% 告警。
- Outbox 最老 `PENDING` 超过 30 秒告警。

### 11.2 扩容原则

增加消费者前先检查模型供应商的 RPM、TPM 和并发限制。消费者数乘以单实例并发不能超过供应商额度，否则扩容只会制造更多 429 和重试费用。

先调整 Consumer 并发和 Prefetch，再增加实例。Prefetch 不宜远大于实际并发，否则单实例会持有大量未 ACK 消息，导致其他实例空闲。

### 11.3 发布与迁移顺序

1. 先部署数据库新增字段、Outbox 和索引，保持旧代码兼容。
2. 部署 Publisher 和 Consumer，但保持生产消费开关关闭。
3. 验证拓扑、权限、重试和 DLQ。
4. 开启 Outbox 写入，使用影子审核：记录结果但不撤回、不处罚。
5. 对比误判率、延迟、成本和积压。
6. 开启 `REJECT` 撤回。
7. 最后启用警告和限时禁言。
8. 稳定后移除发送链路中的同步 AI 审核。

不能先删除同步审核再部署消费者，否则发布窗口内会产生未审核消息。

### 11.4 回滚

- 通过配置停止 Outbox Publisher 或 Consumer，不删除 Queue。
- 保留消息与 Outbox 数据，修复后继续处理。
- 撤回动作出现误判时关闭动作开关，审核可继续以影子模式运行。
- 禁止通过清空 Queue 回滚；需要停止消费、导出必要指标并决定重放或标记 DEGRADED。

### 11.5 DLQ 重放

重放前必须确认根因已修复，并按小批量执行：

1. 统计 DLQ 的事件版本、失败原因和时间范围。
2. 抽样验证消息仍存在且尚无最终审核结果。
3. 每批重放有限数量，保持原 `eventId`。
4. 观察 AI 429、Token 消耗和主队列 Lag。
5. 重放完成后核对 DLQ、审核结果和 Outbox 状态。

不要把 DLQ 直接整体绑定回主 Exchange，这可能瞬间耗尽模型配额。

## 12. 任务拆分

以下任务按依赖顺序排列，每项应独立提交并具备验收条件。

### T1：协议与数据模型

内容：

- 定义审核状态枚举、V1 事件类型和拓扑常量。
- 给 Message 增加审核状态和时间字段。
- 新增 `ModerationOutbox` 及必要索引、唯一约束。
- 调整 `MessageModeration` 的幂等和版本字段。

验收：迁移可在已有数据上执行；旧消息有明确回填状态；Prisma Client 和构建通过。

预计：1 天。依赖：无。

### T2：消息事务与 Outbox 写入

内容：

- 将消息落库和 Outbox 创建放进同一个 Prisma 事务。
- 保留 `senderId + clientMessageId` 幂等。
- 非文本消息按明确策略设置状态。
- 暂时保留同步审核开关，支持灰度迁移。

验收：模拟事务任一步失败时不会出现只有消息或只有 Outbox；重复发送不会创建重复事件。

预计：1 天。依赖：T1。

### T3：Outbox Publisher

内容：

- 分批抢占待发布记录，处理锁超时恢复。
- 使用 persistent 消息和 Publisher Confirm。
- 成功标记 `PUBLISHED`，失败退避重试。
- 增加已发布历史清理任务。

验收：进程在 publish 前后强制退出均不会永久漏投；多个 Publisher 不会持续重复抢占同一记录。

预计：1-2 天。依赖：T1、T2。

### T4：审核 Queue Service 与独立 Channel

内容：

- 创建主队列、Retry Queue、DLQ 和 Routing Key。
- 为邮件和审核消费者拆分 Channel/QoS。
- 实现发布 Retry、DLQ 和 Header 约定。

验收：拓扑可重复声明；审核消费者 Prefetch 不影响邮件消费者；Retry 到期能回到主队列。

预计：1 天。依赖：T1。

### T5：AI 审核 Consumer

内容：

- 校验事件并查询消息。
- 复用纯 AI 判断逻辑，移除其对 WebSocket 请求周期的依赖。
- 实现最终结果幂等、Token 记录、错误分类、重试和 DLQ。
- 增加消费者启停、并发、Prefetch 和最大重试配置。

验收：重复事件只产生一个最终结果；临时失败按次数重试；永久错误和耗尽事件进入 DLQ；数据库提交后才 ACK。

预计：2 天。依赖：T1、T4。

### T6：审核后撤回与客户端协议

内容：

- `REJECT` 后软删除或隐藏消息。
- 广播 `message:moderated`。
- 历史、同步、收藏和未读计算统一遵守可见性。
- 更新 WebSocket 文档和客户端示例。

验收：在线和离线客户端都不能继续看到已拒绝正文；重复动作不会重复广播副作用。

预计：1-2 天。依赖：T5。

### T7：风险事件、警告与禁言

内容：

- 新增违规和限制数据模型。
- 建立带版本的风险积分规则。
- 发送入口同步检查禁言。
- 警告、禁言和解除操作幂等，并预留人工复核和申诉字段。

验收：风险累计达到阈值后执行正确动作；过期禁言自动失效；AI/基础设施降级不会处罚用户。

预计：2-3 天。依赖：T5，可与 T6 后半段并行。

### T8：可观测性、压测与灰度

内容：

- 增加 Queue Lag、Outbox Lag、结果比例、Token 和 DLQ 指标。
- 编写 Outbox 崩溃恢复、重复投递、Retry、DLQ 和重放测试。
- 先运行影子审核，再灰度开启撤回和处罚。
- 编写生产操作和故障演练记录。

验收：达到预设发送吞吐时聊天主链路不等待 AI；消费者停止后消息不丢失，恢复后能追平；告警能够发现积压和 DLQ。

预计：2 天。依赖：T2-T7。

## 13. 推荐实施批次

| 批次 | 任务 | 可交付结果 |
| --- | --- | --- |
| 第一批 | T1-T4 | 消息可靠产生并投递审核事件，尚不调用 AI |
| 第二批 | T5 | AI 异步影子审核、Token 统计、重试和 DLQ |
| 第三批 | T6 | 审核拒绝后撤回，客户端状态一致 |
| 第四批 | T7-T8 | 警告、禁言、监控、压测和生产灰度 |

完整实现预计 10-13 个工程日，取决于客户端撤回改造、监控基础设施和人工复核范围。最小可用异步影子审核为 T1-T5，预计 6-7 个工程日。

## 14. 上线验收清单

- 消息和 Outbox 同事务提交。
- 生产事件不携带聊天正文和凭据。
- Publisher 使用 Confirm，并能恢复超时锁。
- Consumer 最终结果、撤回、警告和禁言全部幂等。
- Retry 只处理临时错误，重试次数有上限。
- DLQ 非空有告警和可审计重放流程。
- 邮件与审核消费者的 Channel 和 Prefetch 相互隔离。
- 历史查询、可靠同步和实时事件对拒绝消息的展示一致。
- AI Token、重试费用、Queue Lag 和 Outbox Lag 可观测。
- 影子审核验证误判率后才开启自动撤回。
- 永久封禁和高风险处罚需要人工复核或明确的独立规则。
