# RabbitMQ 消费者未执行与连接恢复逻辑复盘

## 1. 背景

项目通过 RabbitMQ 处理验证码邮件，并新增了聊天消息 AI 异步审核。两类业务复用 `RabbitmqService` 管理连接和发布，但各自使用独立 Queue、Routing Key 和 Consumer Channel。

实际观察到的现象是：生产者执行了消息投递，但邮件消费服务似乎没有执行。排查后确认同时存在环境问题和代码恢复逻辑问题：

- 当前开发机没有运行 RabbitMQ 容器，`127.0.0.1:5672` 没有进程监听。
- 消费者初始化失败后没有再次注册，即使 RabbitMQ 后续恢复也不会开始消费。
- `RabbitmqService` 对 Connection、Publisher Channel 和 Consumer Channel 的失效状态处理不完整。

本文记录问题之间的因果关系、代码改造思路、状态机边界和后续验证方式。

## 2. 先区分三个对象

RabbitMQ 客户端不是只有一个“连接”。当前实现包含三层对象：

```text
RabbitMQ Connection
├── Publisher ConfirmChannel
├── Mail Consumer Channel
└── Chat Moderation Consumer Channel
```

### Connection

TCP/AMQP 连接，是所有 Channel 的承载对象。Connection 关闭后，它上面的所有 Channel 都会失效。

### Publisher ConfirmChannel

用于声明 Exchange、Queue、Binding，并发布业务消息。发布后通过 Publisher Confirm 判断 Broker 是否确认接收。

### Consumer Channel

用于 `prefetch`、`consume`、`ack` 和 `nack`。邮件与聊天审核分别使用独立 Channel，防止一个消费者的 Prefetch 或 Channel 异常影响另一个消费者。

三层对象的生命周期不同：

- Connection 可能整体断开。
- Publisher Channel 可能因拓扑声明错误等原因单独关闭，而 Connection 仍然存活。
- 某个 Consumer Channel 可能单独关闭，其他消费者和发布仍然正常。

因此不能只监听 Connection，也不能用一个布尔值代表整个 RabbitMQ 状态。

## 3. 首次发现的直接环境原因

项目未显式配置远程 `RABBITMQ_URL` 时，会根据环境变量构造地址，默认主机为：

```text
127.0.0.1:5672
```

排查时 Docker 中只有 Redis 相关容器，RabbitMQ 容器没有启动，本机 `5672` 端口也没有监听。因此应用启动时无法声明邮件 Queue，也无法注册消费者。

这个问题本身足以导致邮件不消费，但它还暴露了代码中的恢复缺陷：RabbitMQ 后续即使启动，邮件消费者也不一定能够恢复。

## 4. 核心故障因果链

原邮件消费者启动流程是：

```text
MailQueueConsumer.onModuleInit
  -> setupTopology()
     -> 连接 RabbitMQ
     -> 声明 Exchange / Queue / Binding
  -> rabbitmqService.consume(...)
     -> 注册消费回调
```

当 RabbitMQ 在应用启动时不可用：

```text
setupTopology() 抛出异常
  -> onModuleInit catch
  -> consume() 没有执行
  -> RabbitmqService 内没有保存邮件消费者注册信息
```

后续生产者投递时可能触发 RabbitMQ 重连：

```text
RabbitMQ 后来启动
  -> 某次 publish 建立新 Connection
  -> 生产者成功发布消息
  -> RabbitmqService 尝试恢复“已注册消费者”
  -> 注册表中没有邮件消费者
  -> Queue 中存在消息，但没有 Consumer
```

这解释了为什么会出现“投递日志存在，但消费逻辑没有执行”。问题不是消息 Handler 内部代码没有运行，而是 Handler 从未注册到 RabbitMQ。

## 5. 消费者启动重试改造

邮件和聊天审核消费者都增加了独立的启动状态：

```text
starting  防止并发执行两次启动
started   表示拓扑和 consume 已成功
stopped   表示应用正在关闭，禁止继续重试
timer     保存下一次启动重试定时器
```

改造后的流程：

```text
onModuleInit
  -> start()
     -> setupTopology()
     -> consume()
     -> 成功：started = true
     -> 失败：5 秒后再次 start()
```

这层重试解决的是“首次启动时 RabbitMQ 尚未就绪”。只有拓扑声明和 `consume()` 都成功后，消费者才被认为已经启动。

应用关闭时会：

- 设置 `stopped = true`；
- 清除启动重试 Timer；
- 不再创建新 Channel。

避免 Nest 应用退出过程中，后台 Timer 又重新连接 RabbitMQ。

## 6. RabbitmqService 消费者注册表

`RabbitmqService.consume()` 会把以下内容保存到注册表：

```text
Queue 名称
消费回调
Prefetch 配置
```

注册表与活动 Channel 是两个概念：

```text
consumerRegistrations  希望长期存在的消费者定义
activeConsumerQueues   当前已经成功订阅的 Queue
startingConsumerQueues 当前正在创建 Channel 的 Queue
consumerChannels       当前实际打开的 Consumer Channel
```

Connection 断开时，活动 Channel 集合会清空，但注册表保留。新 Connection 建立后，根据注册表重新创建 Consumer Channel 和订阅。

这样解决的是“消费者已经正常运行过，之后 RabbitMQ 连接发生中断”的恢复问题。

消费者自己的 5 秒启动重试和 `RabbitmqService` 的注册表恢复并不重复：

- 启动重试负责消费者还没有注册成功的情况。
- 注册表恢复负责已经注册过、运行中连接断开的情况。

## 7. Publisher Channel 失效问题

原逻辑只缓存 `publisherChannel`，但没有监听它自己的 `close` 事件：

```text
Publisher Channel 被 Broker 关闭
  -> Connection 可能仍然存活
  -> publisherChannel 字段仍然指向旧对象
  -> getChannel() 一直返回已关闭 Channel
  -> 后续 publish / assertQueue 持续失败
```

Publisher Channel 可能因为以下原因单独关闭：

- 使用相同 Queue 名声明了不兼容的参数；
- Exchange 类型或持久化参数冲突；
- Channel 级协议异常；
- Broker 主动关闭 Channel。

修复方式：

1. 给 Publisher Channel 监听 `error` 和 `close`。
2. `close` 时仅在它仍是当前 Channel 时清空引用。
3. Connection 仍可用时，在原 Connection 上创建新的 ConfirmChannel。
4. 使用 `creatingPublisher` Promise 合并并发创建请求，避免多个业务请求同时创建多个 Publisher Channel。

## 8. 旧连接覆盖新连接问题

异步事件存在时序问题：旧 Connection 的 `close` 事件可能晚于新 Connection 建立。

错误流程：

```text
Connection A 发生异常
  -> 开始创建 Connection B
  -> B 建立成功并写入 this.connection
  -> A 的 close 事件稍后到达
  -> 无条件 this.connection = null
  -> B 被状态字段“误删除”
```

修复后，Connection 事件先比较对象身份：

```ts
if (this.connection !== connection) return;
```

只有当前仍被服务持有的 Connection 才能清理当前状态。旧连接的迟到事件不能影响新连接。

Publisher Channel 的 `close` 处理也使用相同原则：

```ts
if (this.publisherChannel !== channel) return;
```

这是异步资源管理中的通用规则：资源事件只能修改属于该资源自己的当前状态。

## 9. Consumer Channel 泄漏问题

原 `startConsumer()` 的执行顺序包括：

```text
createChannel
  -> prefetch
  -> consume
```

如果 Channel 创建成功，但 `prefetch()` 或 `consume()` 失败，原逻辑只移除活动 Queue 标记，没有关闭已经创建的 Channel。

持续重试可能造成：

- Connection 上残留越来越多的 Channel；
- 最终达到 Broker 的 Channel 数量限制；
- 后续正常消费者也无法创建 Channel。

修复后，在启动失败的 `catch` 中：

```text
移除 activeConsumerQueues
移除 consumerChannels
关闭临时 Channel
再次抛出异常，由上层安排重试
```

## 10. 为什么邮件与 AI 审核使用独立 Channel

原实现可能在共享 Channel 上设置 Prefetch。这样邮件消费者设置 `prefetch=5` 后，AI 审核消费者再设置另一个值，实际行为依赖调用顺序和 RabbitMQ QoS 作用范围。

拆分后：

```text
Mail Consumer Channel
  -> MAIL_PREFETCH

Chat Moderation Consumer Channel
  -> CHAT_MODERATION_PREFETCH
```

收益：

- 两类消费者的未 ACK 数量相互独立；
- AI 模型调用较慢时不会占用邮件消费额度；
- 某个 Consumer Channel 被关闭时不会中断另一类消费者；
- 可以独立调整并发和扩容。

## 11. Publisher Confirm 的含义

`channel.publish()` 返回的布尔值表示客户端写缓冲区是否仍有空间，不表示 Broker 已经持久化消息。

当前发布流程是：

```text
ConfirmChannel.publish
  -> waitForConfirms
  -> Broker ACK 后方法成功
  -> Broker NACK 或 Channel 关闭时方法抛错
```

这样 Outbox Publisher 只有在 Broker 确认后才把事件标为 `PUBLISHED`，邮件接口也只有在发布确认后才认为验证码邮件任务已进入队列。

需要注意：Publisher Confirm 不能消除重复消息。如果 Broker 已确认，但应用在更新数据库前崩溃，Outbox 仍可能重新发布。消费者必须继续依靠 `eventId` 和业务唯一约束实现幂等。

## 12. 当前恢复状态机

```text
应用启动
  -> getChannel
     -> 成功：保存 Connection + Publisher Channel
     -> 失败：记录日志并安排重连

消费者启动
  -> setupTopology + consume
     -> 成功：保存注册并标记 active
     -> 失败：消费者自身 5 秒后重试

Publisher Channel close
  -> 清空当前 Publisher Channel
  -> 在现有或新 Connection 上重建

Consumer Channel close
  -> 清除该 Queue 的 active 状态
  -> 根据注册表重新创建 Channel 和 consume

Connection close
  -> 仅当前 Connection 可以清理状态
  -> 保留消费者注册表
  -> 建立新 Connection 和 Publisher Channel
  -> 恢复所有已注册消费者

应用关闭
  -> 禁止重连
  -> 清理 Timer
  -> 关闭 Consumer Channels
  -> 关闭 Publisher Channel
  -> 关闭 Connection
```

## 13. 日志与排查顺序

正常启动至少应看到：

```text
rabbitmq.connected
rabbitmq.consumer_restored  queue=mail.verification.send.queue
rabbitmq.consumer_started   queue=mail.verification.send.queue
```

AI 审核开启时还应看到：

```text
rabbitmq.consumer_restored  queue=chat.moderation.requested.queue
chat_moderation.consumer_started
```

邮件投递和处理应形成对应日志：

```text
rabbitmq.message_published
rabbitmq.message_processed
```

建议按以下顺序排查：

1. 检查 RabbitMQ 进程或容器是否运行，5672 是否监听。
2. 检查应用实际使用的 `RABBITMQ_URL` 或 Host、Port、用户名、Vhost。
3. 检查 `rabbitmq.connected`。
4. 检查目标 Queue 的 `consumer_count` 是否大于 0。
5. 检查 `messages_ready` 和 `messages_unacknowledged`。
6. 检查 `consumer_started` 或反复出现的 `consumer_start_failed`。
7. 检查 Retry Queue 和 DLQ，而不是只看主 Queue。
8. 检查 Redis 中的验证码是否仍存在；邮件消费者会跳过过期或已被新验证码替代的任务。

## 14. 尚未完成的验证与剩余风险

当前已完成：

- Prisma Schema 校验；
- TypeScript/Nest 构建；
- 静态代码和 Diff 检查。

当前开发机没有运行 RabbitMQ，因此还没有完成以下真实环境验证：

- RabbitMQ 晚于应用启动时，消费者是否在 5 秒重试后出现；
- 发送验证码后 Queue 的 ready/unacked/consumer_count 变化；
- 强制关闭 Publisher Channel 后能否自动重建；
- 重启 RabbitMQ 后邮件和审核 Consumer 是否都恢复；
- Retry Queue 到期回流及 DLQ 行为。

剩余风险：

- 重连间隔当前固定为 1 秒，长时间故障时日志较多，后续可改为带抖动的指数退避。
- 普通 RabbitMQ 重启会保留 durable 拓扑；若连接的是全新空 Broker，需要确保业务 Queue Service 重新声明拓扑，不能只恢复 `consume()`。
- Publisher Confirm 当前按调用等待确认，可靠性优先但吞吐有限；高吞吐阶段可改为批量 Confirm 和受控并发。
- 实时运行指标尚未接入 Prometheus，当前主要依赖结构化日志和 RabbitMQ Management UI。

## 15. 复盘结论

这次问题不能只归因于“RabbitMQ 没启动”。基础设施未就绪是触发条件，消费者初始化失败后没有注册和恢复能力才是代码层根因。

改造的核心原则是：

1. 区分 Connection、Publisher Channel 和 Consumer Channel 的生命周期。
2. 首次启动失败和运行中断线使用不同恢复机制。
3. 保留消费者定义，重建瞬时 Channel。
4. 异步资源事件必须校验对象身份，避免旧事件覆盖新状态。
5. 发布使用 Confirm，消费使用 ACK，但端到端仍通过业务幂等处理重复。
6. 邮件和 AI 审核共享 Connection 管理能力，但隔离 Queue、Channel、Prefetch、重试和 DLQ。
