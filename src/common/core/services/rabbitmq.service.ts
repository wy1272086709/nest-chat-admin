import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Options,
} from 'amqplib';

type ConsumerRegistration = {
  onMessage: (message: ConsumeMessage, channel: Channel) => Promise<void>;
  options: { prefetch?: number };
};

@Injectable()
export class RabbitmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private connection: ChannelModel | null = null;
  private publisherChannel: ConfirmChannel | null = null;
  private readonly consumerChannels = new Set<Channel>();
  private readonly consumerRegistrations = new Map<
    string,
    ConsumerRegistration
  >();
  private readonly activeConsumerQueues = new Set<string>();
  private readonly startingConsumerQueues = new Set<string>();
  private connecting: Promise<ConfirmChannel | null> | null = null;
  private creatingPublisher: Promise<ConfirmChannel> | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    try {
      await this.getChannel();
    } catch (error) {
      this.logger.error({
        event: 'rabbitmq.initialization_failed',
        err: error,
      });
      this.scheduleReconnect();
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.close();
  }

  async getChannel(): Promise<ConfirmChannel> {
    if (this.publisherChannel) return this.publisherChannel;
    if (this.connection) return this.createPublisherChannel(this.connection);

    const channel = await this.connect();
    if (!channel) {
      throw new Error('RabbitMQ 连接不可用');
    }

    return channel;
  }

  async publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
    options: Options.Publish = {},
  ): Promise<boolean> {
    const channel = await this.getChannel();
    const content = Buffer.from(JSON.stringify(payload));
    const accepted = channel.publish(exchange, routingKey, content, {
      contentType: 'application/json',
      deliveryMode: 2,
      timestamp: Date.now(),
      ...options,
    });
    await channel.waitForConfirms();
    return accepted;
  }

  async consume(
    queue: string,
    onMessage: (message: ConsumeMessage, channel: Channel) => Promise<void>,
    options: { prefetch?: number } = {},
  ): Promise<void> {
    this.consumerRegistrations.set(queue, { onMessage, options });
    await this.getChannel();
    await this.startConsumer(queue);
  }

  async assertTopicExchange(name: string): Promise<void> {
    const channel = await this.getChannel();
    await channel.assertExchange(name, 'topic', { durable: true });
  }

  async assertQueue(
    name: string,
    options: Options.AssertQueue = { durable: true },
  ): Promise<void> {
    const channel = await this.getChannel();
    await channel.assertQueue(name, options);
  }

  async bindQueue(
    queue: string,
    exchange: string,
    routingKey: string,
  ): Promise<void> {
    const channel = await this.getChannel();
    await channel.bindQueue(queue, exchange, routingKey);
  }

  private async connect(): Promise<ConfirmChannel | null> {
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const url = this.configService.get<string>(
        'rabbitmq.url',
        'amqp://guest:guest@127.0.0.1:5672',
      );

      try {
        const connection = await amqp.connect(url);

        connection.on('error', (error) => {
          this.logger.error({ event: 'rabbitmq.connection_error', err: error });
        });

        connection.on('close', () => {
          if (this.connection !== connection) return;
          this.logger.warn({ event: 'rabbitmq.connection_closed' });
          this.connection = null;
          this.publisherChannel = null;
          this.creatingPublisher = null;
          this.consumerChannels.clear();
          this.activeConsumerQueues.clear();
          this.scheduleReconnect();
        });

        this.connection = connection;
        const channel = await this.createPublisherChannel(connection);

        this.logger.log({ event: 'rabbitmq.connected' });
        void this.restoreConsumers();
        return channel;
      } catch (error) {
        this.connection = null;
        this.publisherChannel = null;
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  private async close() {
    try {
      await Promise.all(
        Array.from(this.consumerChannels).map((channel) =>
          channel.close().catch(() => undefined),
        ),
      );
      this.consumerChannels.clear();
      await this.publisherChannel?.close();
      await this.connection?.close();
    } catch (error) {
      this.logger.error({ event: 'rabbitmq.close_failed', err: error });
    } finally {
      this.publisherChannel = null;
      this.creatingPublisher = null;
      this.connection = null;
    }
  }

  private async startConsumer(queue: string) {
    if (
      this.activeConsumerQueues.has(queue) ||
      this.startingConsumerQueues.has(queue)
    ) {
      return;
    }
    const registration = this.consumerRegistrations.get(queue);
    if (!registration || !this.connection) return;

    this.startingConsumerQueues.add(queue);
    let channel: Channel | undefined;
    try {
      channel = await this.connection.createChannel();
      this.consumerChannels.add(channel);
      this.activeConsumerQueues.add(queue);
      channel.on('close', () => {
        this.consumerChannels.delete(channel);
        this.activeConsumerQueues.delete(queue);
        if (!this.shuttingDown && this.connection) this.scheduleReconnect();
      });
      channel.on('error', (error) => {
        this.logger.error({
          event: 'rabbitmq.consumer_channel_error',
          queue,
          error,
        });
      });
      if (registration.options.prefetch) {
        await channel.prefetch(registration.options.prefetch);
      }
      await channel.consume(
        queue,
        async (message) => {
          if (!message) return;
          try {
            await registration.onMessage(message, channel);
          } catch (error) {
            this.logger.error({
              event: 'rabbitmq.consume_failed',
              eventId: message.properties.messageId,
              queue,
              attempts: this.getAttempts(message),
              err: error,
            });
            channel.nack(message, false, false);
          }
        },
        { noAck: false },
      );
      this.logger.log({ event: 'rabbitmq.consumer_restored', queue });
    } catch (error) {
      this.activeConsumerQueues.delete(queue);
      if (channel) {
        this.consumerChannels.delete(channel);
        await channel.close().catch(() => undefined);
      }
      throw error;
    } finally {
      this.startingConsumerQueues.delete(queue);
    }
  }

  private async restoreConsumers() {
    if (!this.connection || this.shuttingDown) return;
    for (const queue of this.consumerRegistrations.keys()) {
      try {
        await this.startConsumer(queue);
      } catch (error) {
        this.logger.error({
          event: 'rabbitmq.consumer_restore_failed',
          queue,
          err: error,
        });
        this.scheduleReconnect();
      }
    }
  }

  private async createPublisherChannel(connection: ChannelModel) {
    if (this.publisherChannel) return this.publisherChannel;
    if (this.creatingPublisher) return this.creatingPublisher;

    this.creatingPublisher = (async () => {
      const channel = await connection.createConfirmChannel();
      if (this.connection !== connection || this.shuttingDown) {
        await channel.close().catch(() => undefined);
        throw new Error('RabbitMQ 连接已切换');
      }
      channel.on('error', (error) => {
        this.logger.error({
          event: 'rabbitmq.publisher_channel_error',
          err: error,
        });
      });
      channel.on('close', () => {
        if (this.publisherChannel !== channel) return;
        this.publisherChannel = null;
        if (!this.shuttingDown) this.scheduleReconnect();
      });
      this.publisherChannel = channel;
      return channel;
    })();

    try {
      return await this.creatingPublisher;
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null;
        this.publisherChannel = null;
        this.consumerChannels.clear();
        this.activeConsumerQueues.clear();
        await connection.close().catch(() => undefined);
        this.scheduleReconnect();
      }
      throw error;
    } finally {
      this.creatingPublisher = null;
    }
  }

  private scheduleReconnect() {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.getChannel();
        await this.restoreConsumers();
      } catch (error) {
        this.logger.error({ event: 'rabbitmq.reconnect_failed', err: error });
        this.scheduleReconnect();
      }
    }, 1000);
    this.reconnectTimer.unref();
  }

  private getAttempts(message: ConsumeMessage): number {
    const attempts = message.properties.headers?.['x-attempts'];
    return typeof attempts === 'number' ? attempts : Number(attempts || 0);
  }
}
