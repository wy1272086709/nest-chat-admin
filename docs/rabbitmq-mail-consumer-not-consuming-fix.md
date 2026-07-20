# RabbitMQ 邮件消息已投递但 Consumer 不消费：故障复盘与修复

## 1. 文档范围

本文只说明一次具体故障：验证码邮件消息已经投递到 RabbitMQ，但 `MailQueueConsumer` 没有执行。

不讨论聊天审核队列、业务错误码或一般性的 RabbitMQ 架构设计。对应修复进入 Git 的提交为：

```text
d0cfdca feat: ai总结以及rabbitMQ的消息发送
```

主要修改文件：

```text
src/common/core/services/rabbitmq.service.ts
src/common/core/services/mail-queue.consumer.ts
deploy.sh
```

## 2. 故障现象

当时可以观察到：

- HTTP 发送验证码接口返回成功；
- Producer 能打印 `rabbitmq.message_published`；
- RabbitMQ 管理页面能看到队列中存在 Ready 消息；
- 没有 `rabbitmq.consumer_started` 或 `rabbitmq.message_processed` 日志；
- 邮件发送函数没有执行。

这里的关键判断是：消息进入队列，只能证明 Publisher 链路可用，不能证明 Consumer 已经注册。

## 3. 直接原因

应用启动时，RabbitMQ 可能还没有完全就绪。旧代码在 `onModuleInit()` 中连接失败后只记录错误，然后允许应用继续启动：

```ts
async onModuleInit() {
  try {
    await this.getChannel();
  } catch (error) {
    this.logger.error({ event: 'rabbitmq.initialization_failed', err: error });
  }
}
```

`MailQueueConsumer.onModuleInit()` 同样只尝试启动一次：

```ts
try {
  await this.mailQueueService.setupTopology();
  await this.rabbitmqService.consume(queue, handler);
} catch (error) {
  this.logger.error({ event: "rabbitmq.consumer_start_failed", err: error });
}
```

启动失败以后，没有定时重试，也没有保存 Consumer 注册信息。

稍后用户调用发送验证码接口时，Producer 再次调用 `getChannel()`，这一次 RabbitMQ 已经就绪，所以连接成功、消息发布成功。但 Consumer 的 `onModuleInit()` 不会再次执行，于是形成：

```text
应用启动
  -> RabbitMQ 尚未就绪
  -> Consumer 注册失败
  -> 异常被捕获，应用继续运行

稍后发送验证码
  -> Producer 重新连接成功
  -> 消息进入队列
  -> 没有活跃 Consumer
  -> Ready 消息持续堆积
```

这就是“投递成功但消费服务没执行”的主要原因。

## 4. 旧实现的第二个问题：发布和消费共用 Channel

旧 `RabbitmqService` 只有一个 Channel：

```ts
private channel: Channel | null = null;
```

发布、声明拓扑、设置 `prefetch`、注册 `consume()` 和 ACK/NACK 都通过这个 Channel 完成。

这会带来两个问题：

1. 发布侧异常关闭 Channel 时，Consumer 也同时丢失；
2. 连接重建后只创建新 Channel，不会自动重新执行原来的 `channel.consume()`。

RabbitMQ 的 Consumer 是注册在 Channel 上的。创建新连接或新 Channel，并不意味着旧 Consumer 会自动恢复。

## 5. 修复一：保存 Consumer 注册信息

新增注册表，保存队列、处理函数和 `prefetch`：

```diff
+type ConsumerRegistration = {
+  onMessage: (message: ConsumeMessage, channel: Channel) => Promise<void>;
+  options: { prefetch?: number };
+};

-private channel: Channel | null = null;
+private publisherChannel: ConfirmChannel | null = null;
+private readonly consumerChannels = new Set<Channel>();
+private readonly consumerRegistrations = new Map<
+  string,
+  ConsumerRegistration
+>();
+private readonly activeConsumerQueues = new Set<string>();
+private readonly startingConsumerQueues = new Set<string>();
```

`consume()` 不再只在当前 Channel 上临时注册，而是先保存注册信息：

```diff
 async consume(queue, onMessage, options = {}) {
-  const channel = await this.getChannel();
-  await channel.consume(queue, handler, { noAck: false });
+  this.consumerRegistrations.set(queue, { onMessage, options });
+  await this.getChannel();
+  await this.startConsumer(queue);
 }
```

这样连接断开后，服务仍然知道需要恢复哪些队列。

## 6. 修复二：Publisher 和 Consumer 使用独立 Channel

Publisher 使用 `ConfirmChannel`：

```ts
private publisherChannel: ConfirmChannel | null = null;
```

每个 Consumer 使用独立普通 Channel：

```ts
channel = await this.connection.createChannel();
await channel.prefetch(registration.options.prefetch);
await channel.consume(queue, handler, { noAck: false });
```

职责变为：

```text
ConfirmChannel
  -> publish()
  -> waitForConfirms()

Consumer Channel
  -> prefetch()
  -> consume()
  -> ack()/nack()
```

这不是 RabbitMQ 强制要求，而是隔离故障范围。Publisher Channel 关闭时不应直接带走 Consumer；不同 Consumer 也可以独立设置 QoS。

关键 diff：

```diff
-const channel = await connection.createChannel();
-this.channel = channel;
+const channel = await connection.createConfirmChannel();
+this.publisherChannel = channel;
```

发布端增加 Broker Confirm：

```diff
-return channel.publish(exchange, routingKey, content, options);
+const accepted = channel.publish(exchange, routingKey, content, options);
+await channel.waitForConfirms();
+return accepted;
```

`waitForConfirms()` 只确认 Broker 接收了发布消息，不代表邮件已经发送，也不代表 Consumer 已处理完成。

## 7. 修复三：连接恢复后重新注册 Consumer

连接关闭时清理失效状态并调度重连：

```diff
 connection.on('close', () => {
   this.connection = null;
-  this.channel = null;
+  this.publisherChannel = null;
+  this.consumerChannels.clear();
+  this.activeConsumerQueues.clear();
+  this.scheduleReconnect();
 });
```

连接成功后恢复全部注册过的 Consumer：

```ts
private async restoreConsumers() {
  if (!this.connection || this.shuttingDown) return;
  for (const queue of this.consumerRegistrations.keys()) {
    await this.startConsumer(queue);
  }
}
```

连接创建成功时调用：

```diff
 this.logger.log({ event: 'rabbitmq.connected' });
+void this.restoreConsumers();
```

同时通过 `activeConsumerQueues` 和 `startingConsumerQueues` 防止同一队列被重复注册。

## 8. 修复四：Consumer 首次启动失败后主动重试

仅靠连接恢复仍不够。`MailQueueConsumer` 自身的拓扑声明或注册也可能失败，因此增加独立的启动状态和 5 秒重试：

```diff
+private startTimer?: NodeJS.Timeout;
+private starting = false;
+private started = false;
+private stopped = false;
```

```diff
 catch (error) {
   this.logger.error({
     event: 'rabbitmq.consumer_start_failed',
     queue: this.mailQueueService.queue,
     err: error,
   });
+  this.scheduleStartRetry();
 }
```

```ts
private scheduleStartRetry() {
  if (this.stopped || this.started || this.startTimer) return;
  this.startTimer = setTimeout(() => {
    this.startTimer = undefined;
    void this.start();
  }, 5000);
  this.startTimer.unref();
}
```

`starting` 防止并发启动，`started` 防止重复消费，`stopped` 防止应用退出时继续重试。

## 9. 修复五：prefetch 绑定到具体 Consumer Channel

旧代码在共享 Channel 上单独调用：

```diff
-await this.rabbitmqService.prefetch(prefetch);
-await this.rabbitmqService.consume(queue, handler);
```

修复后把配置传入 Consumer 注册：

```diff
 await this.rabbitmqService.consume(queue, handler, {
+  prefetch: this.configService.get<number>(
+    'rabbitmq.mailVerificationPrefetch',
+    5,
+  ),
 });
```

最终在新建的 Consumer Channel 上执行 `channel.prefetch()`，连接恢复重新创建 Channel 时也会重新应用配置。

## 10. 部署顺序补强

代码具备重连能力后，部署层仍应尽量减少启动竞态。部署脚本调整为：

```diff
-docker compose ... up -d
-docker rm -f "$CONTAINER"
+docker rm -f "$CONTAINER"
+docker compose ... up -d --wait --wait-timeout 120
```

现在顺序是：

```text
停止旧应用
  -> 启动 RabbitMQ/Redis/MinIO
  -> 等待依赖 healthcheck 通过
  -> 启动新应用
```

`--wait` 降低首次连接失败概率，但不能替代应用内部重连。RabbitMQ 在运行期仍可能重启或网络闪断，所以两层保护都需要。

## 11. 修复后的完整时序

正常启动：

```text
MailQueueConsumer.onModuleInit()
  -> setupTopology()
  -> RabbitmqService.consume()
  -> 保存 consumerRegistrations
  -> 创建独立 Consumer Channel
  -> prefetch(5)
  -> channel.consume()
  -> rabbitmq.consumer_started
```

RabbitMQ 暂时不可用：

```text
首次连接失败
  -> RabbitmqService.scheduleReconnect(1s)
  -> MailQueueConsumer.scheduleStartRetry(5s)
  -> RabbitMQ 恢复
  -> 创建 Publisher ConfirmChannel
  -> restoreConsumers()
  -> 创建 Consumer Channel
  -> 重新执行 consume()
```

运行中连接断开：

```text
connection close
  -> 清理失效 Channel 状态
  -> 保留 consumerRegistrations
  -> 1 秒后重连
  -> restoreConsumers()
  -> Ready 消息继续被消费
```

## 12. 如何确认已经恢复

应用启动后应看到：

```text
rabbitmq.connected
rabbitmq.consumer_restored queue=mail.verification.send.queue
rabbitmq.consumer_started queue=mail.verification.send.queue
```

投递和消费同一个 `eventId` 应依次出现：

```text
rabbitmq.message_published
rabbitmq.message_processed
```

RabbitMQ 管理页面检查：

- Queue 的 Consumers 数量大于 `0`；
- Ready 数量能够下降；
- Unacked 只在处理期间短暂增加；
- SMTP 失败时能看到 retry，超过次数进入 DLQ。

如果只有 `message_published` 而没有 `consumer_started`，优先检查 Consumer 注册和启动配置，而不是邮件模板。

## 13. 结论

这次故障的本质是生命周期恢复缺失：Producer 可以在 RabbitMQ 恢复后重新连接并发布，但 Consumer 只在应用初始化时注册一次，失败或断线后不会自动恢复。

最终通过四个关键机制修复：

1. 保存 Consumer 注册信息；
2. Publisher 与 Consumer 使用独立 Channel；
3. 连接重建后自动恢复 Consumer；
4. Consumer 首次启动失败后定时重试。

部署脚本的依赖健康等待是额外保护，不是核心修复的替代品。
