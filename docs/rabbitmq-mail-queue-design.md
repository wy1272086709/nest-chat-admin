# RabbitMQ 邮件队列设计说明

## 背景

当前项目的注册、找回密码等流程需要发送邮箱验证码。邮件发送依赖 SMTP 或第三方邮件服务，天然存在以下问题：

- 外部服务响应慢，会拖慢接口响应。
- 外部服务临时失败，会导致注册/找回密码接口失败。
- 高峰期大量发送验证码，会对邮件服务形成瞬时压力。
- 同步发送不方便做重试、失败记录和死信排查。

因此，邮件发送适合改成异步队列：

```txt
用户请求发送验证码
  -> 后端校验邮箱、限流、生成验证码
  -> 验证码写入数据库
  -> 投递 RabbitMQ 消息
  -> HTTP 接口立即返回
  -> Mail Consumer 异步发送邮件
  -> 成功 ack，失败重试，超过次数进入死信队列
```

这个设计仍然保持单体架构，只是把外部 I/O 较慢、可重试的任务从主请求链路中拆出去。

## 目标

- 发送验证码接口不再被 SMTP 阻塞。
- 邮件发送失败后可以自动重试。
- 多次失败的任务进入死信队列，便于排查。
- 消费端具备业务幂等能力，避免重复消费导致重复发送。
- 为后续聊天消息审核、AI 审核等异步任务积累 RabbitMQ 能力。

## 非目标

- 不把聊天消息主链路改成 MQ。
- 不为了队列拆分微服务。
- 不在邮件 Consumer 中生成验证码。
- 不把验证码明文长期保存或返回给前端。

## 队列设计

### Exchange

建议使用 topic exchange：

```txt
app.events
```

原因：

- 后续可以继续扩展 `message.moderation.requested`、`ai.moderation.requested` 等事件。
- routing key 具备业务语义，便于观察和排查。

### Queue

邮件队列：

```txt
mail.verification.send.queue
```

死信队列：

```txt
mail.verification.send.dlq
```

Routing key：

```txt
mail.verification.send
```

### 消息体

```ts
type MailVerificationSendMessage = {
  eventId: string
  verificationId: string
  email: string
  type: 'REGISTER' | 'FORGET_PASSWORD'
  code: string
  expiresAt: string
  requestedAt: string
}
```

字段说明：

- `eventId`：事件唯一 ID，用于日志追踪和消息幂等。
- `verificationId`：验证码记录 ID，消费端用它查询业务状态。
- `email`：收件邮箱。
- `type`：验证码用途。
- `code`：验证码。只用于发送邮件，不写入日志。
- `expiresAt`：验证码过期时间。
- `requestedAt`：用户请求发送时间。

## 发送验证码流程

```txt
POST /users/sendEmail
  -> 校验邮箱格式
  -> 校验 type
  -> 检查发送频率
  -> 生成验证码
  -> 写入 EmailVerification 表
  -> 发布 RabbitMQ 消息
  -> 返回：验证码已发送，请查收邮箱
```

接口响应：

```json
{
  "result": true,
  "code": 200,
  "data": null,
  "message": "验证码已发送，请查收邮箱"
}
```

这里的“已发送”表示验证码记录已创建且邮件任务已投递。真正 SMTP 发送由 Consumer 异步完成。

## Consumer 处理流程

```txt
MailConsumer 收到消息
  -> 根据 verificationId 查询验证码记录
  -> 如果记录不存在：ack，记录异常日志
  -> 如果已发送：ack，幂等跳过
  -> 如果已过期：ack，跳过发送
  -> 调用 SMTP 发送邮件
  -> 成功：更新 sentAt，ack
  -> 失败：throw/nack，让 RabbitMQ 重试
  -> 超过重试次数：进入 DLQ
```

消费端必须幂等。RabbitMQ 保证“至少一次投递”，不能假设每条消息只会消费一次。

## 重试与死信

推荐策略：

- 最大重试次数：`3`
- 第一次失败：延迟 `5s`
- 第二次失败：延迟 `30s`
- 第三次失败：延迟 `2min`
- 仍失败：进入死信队列

如果使用 RabbitMQ 原生能力，可以通过 TTL + DLX 组合实现延迟重试；如果想简化第一版，也可以先使用固定重试队列。

死信消息需要保留：

- 原始消息体
- 失败原因
- 失败次数
- 最后失败时间

后台或运维脚本可以支持手动重新投递。

## 数据表建议

验证码记录表：

```txt
EmailVerification
  id
  email
  type
  codeHash
  expiresAt
  usedAt
  sentAt
  sendFailedAt
  sendFailureReason
  createdAt
  updatedAt
```

注意：

- 数据库存 `codeHash`，不要存验证码明文。
- 消息体中可以携带明文 code 用于发送，但日志禁止打印 code。
- 如果担心消息队列中的明文验证码风险，可以 Consumer 收到消息后从临时安全存储读取，或对消息体加密。个人项目第一版可以先做好日志脱敏。

## 限流与防刷

发送验证码接口需要做限流：

- 同邮箱同类型：60 秒冷却。
- 同邮箱每天最多发送固定次数。
- 同 IP 每分钟最多发送固定次数。
- 重新发送时可以让旧验证码失效，只保留最新验证码有效。

限流状态可以放 Redis，最终验证码状态放数据库。

## 为什么邮件适合 RabbitMQ

邮件发送满足 RabbitMQ 的典型使用场景：

- 非实时强依赖：用户不需要等待 SMTP 完成。
- 可重试：失败后可以稍后重试。
- 可削峰：请求高峰时先进入队列。
- 可追踪：失败任务可进入死信队列。
- 可扩展：后续可以独立扩展 Mail Consumer。

## RabbitMQ 和 Redis 队列怎么选

### 适合 RabbitMQ 的场景

RabbitMQ 更适合“业务事件”和“可靠异步任务”：

- 邮件发送。
- 短信发送。
- AI 内容审核。
- 聊天消息异步复审。
- 文件上传后的病毒扫描、转码、缩略图生成。
- 多个消费者订阅同一业务事件。
- 需要 ack/nack、死信队列、路由、重试、消费确认的任务。

选择 RabbitMQ 的关键词：

```txt
可靠投递、业务事件、消费者确认、死信队列、多消费者、削峰、跨模块解耦
```

### 适合 Redis 队列的场景

Redis 队列或 BullMQ 更适合轻量后台任务、延迟任务和本项目已有 Redis 能力附近的场景：

- 本地开发阶段的简单异步任务。
- 定时清理。
- 短期延迟任务。
- 限流、缓存、验证码冷却。
- WebSocket 在线状态。
- Socket.IO RedisAdapter。
- token refresh 并发锁。

选择 Redis 队列的关键词：

```txt
简单、低成本、已有 Redis、轻量任务、延迟任务、缓存/限流就近使用
```

### 当前项目建议

如果只是从工程实用性出发，验证码邮件用 BullMQ + Redis 已经足够。

但如果目标包含面试展示，RabbitMQ 更适合用于邮件队列，因为它能完整体现：

- Producer / Consumer
- ack / nack
- retry
- dead-letter queue
- 业务幂等
- 异步解耦

推荐当前项目采用：

```txt
RabbitMQ
  ├─ 邮件发送
  └─ 后续 AI/消息审核

Redis
  ├─ Socket.IO RedisAdapter
  ├─ 限流
  ├─ 缓存
  └─ token refresh 并发锁
```

## 和聊天消息审核的关系

聊天消息主链路不要全部 MQ 化。

推荐：

```txt
消息发送
  -> 同步检查用户是否禁言/封禁
  -> 同步做轻量敏感词检测
  -> 明确违规：直接拒绝
  -> 正常：落库并广播
  -> 疑似风险：落库为 PENDING_REVIEW，不广播或仅自己可见
  -> 投递 RabbitMQ：message.moderation.requested
  -> AI/人工审核异步处理
```

这样既保留聊天低延迟，又能体现异步审核能力。

## 配置项建议

```env
RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672
RABBITMQ_EXCHANGE=app.events
MAIL_VERIFICATION_QUEUE=mail.verification.send.queue
MAIL_VERIFICATION_ROUTING_KEY=mail.verification.send
MAIL_VERIFICATION_DLX=app.events.dlx
MAIL_VERIFICATION_DLQ=mail.verification.send.dlq

MAIL_SEND_MAX_RETRY=3
MAIL_SEND_COOLDOWN_SECONDS=60
MAIL_VERIFICATION_TTL_SECONDS=300
```

## 开发步骤

1. 安装 RabbitMQ 客户端依赖。
2. 新建 `MessagingModule`，封装 RabbitMQ 连接、exchange、queue 声明。
3. 新建 `MailModule`，迁移现有 SMTP 发送逻辑。
4. 修改 `/users/sendEmail`：生成验证码、写库、发布消息。
5. 新建 `MailConsumer`：消费 `mail.verification.send`。
6. 实现消费幂等：已发送、已过期、已使用的验证码不重复发送。
7. 配置重试和死信队列。
8. 补充限流：邮箱、IP、每日次数。
9. 写文档和测试用例。

## 测试用例

必须覆盖：

- 正常发送验证码：接口快速返回，Consumer 发送邮件。
- SMTP 失败：消息重试。
- 超过重试次数：进入死信队列。
- 重复消费同一消息：不会重复发送。
- 验证码过期后消费：跳过发送并 ack。
- 60 秒内重复请求：接口拒绝。
- 验证码校验成功后再次消费：跳过发送。

## 多 token 自动刷新时间评估

多 token 自动刷新建议作为独立阶段，不和 RabbitMQ 邮件队列同时做。

### 最小可用版

范围：

- 新增 `UserSession` 表。
- 登录时创建 session。
- refresh token 存 hash。
- refresh 接口校验 session 并签发新 access token。
- 当前设备退出时 revoke 当前 session。
- 前端 401 后自动 refresh。
- 前端 single-flight，避免并发刷新。

预计时间：

```txt
2-3 天
```

### 标准版

范围：

- 最小可用版全部能力。
- refresh token rotation。
- 旧 refresh token 重放检测。
- 全设备退出。
- 改密码后撤销全部 session。
- 用户禁用后拒绝 refresh。
- 设备 ID、IP、User-Agent 记录。
- 基础测试和文档。

预计时间：

```txt
4-6 天
```

### 完整后台管理版

范围：

- 标准版全部能力。
- 后台查看用户登录设备。
- 后台踢下线指定设备。
- session 操作日志。
- Redis 辅助缓存/刷新锁。
- 更完整的异常处理和端到端测试。

预计时间：

```txt
7-10 天
```

### 推荐排期

建议先做：

```txt
RabbitMQ 邮件队列：1-2 天
RedisAdapter：1-2 天
多 token 自动刷新最小可用版：2-3 天
多 token 标准版补强：2-3 天
聊天消息审核队列：3-5 天
```

如果时间紧，优先完成：

1. RabbitMQ 邮件队列。
2. 多 token 自动刷新最小可用版。
3. RedisAdapter。

这三块已经能形成很完整的面试叙事：

```txt
异步任务可靠投递 + WebSocket 多实例扩展 + 多设备会话刷新
```
