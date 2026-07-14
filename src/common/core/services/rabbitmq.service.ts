import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage, Options } from 'amqplib';

@Injectable()
export class RabbitmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connecting: Promise<Channel | null> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    try {
      await this.getChannel();
    } catch (error) {
      this.logger.error({ event: 'rabbitmq.initialization_failed', err: error });
    }
  }

  async onModuleDestroy() {
    await this.close();
  }

  async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;

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

    return channel.publish(exchange, routingKey, content, {
      contentType: 'application/json',
      deliveryMode: 2,
      timestamp: Date.now(),
      ...options,
    });
  }

  async consume(
    queue: string,
    onMessage: (message: ConsumeMessage, channel: Channel) => Promise<void>,
  ): Promise<void> {
    const channel = await this.getChannel();
    await channel.consume(
      queue,
      async (message) => {
        if (!message) return;

        try {
          await onMessage(message, channel);
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

  async prefetch(count: number): Promise<void> {
    const channel = await this.getChannel();
    await channel.prefetch(count);
  }

  private async connect(): Promise<Channel | null> {
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const url = this.configService.get<string>(
        'rabbitmq.url',
        'amqp://guest:guest@127.0.0.1:5672',
      );

      try {
        const connection = await amqp.connect(url);
        const channel = await connection.createChannel();

        connection.on('error', (error) => {
          this.logger.error({ event: 'rabbitmq.connection_error', err: error });
          this.connection = null;
          this.channel = null;
        });

        connection.on('close', () => {
          this.logger.warn({ event: 'rabbitmq.connection_closed' });
          this.connection = null;
          this.channel = null;
        });

        this.connection = connection;
        this.channel = channel;

        this.logger.log({ event: 'rabbitmq.connected' });
        return channel;
      } catch (error) {
        this.connection = null;
        this.channel = null;
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  private async close() {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (error) {
      this.logger.error({ event: 'rabbitmq.close_failed', err: error });
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }

  private getAttempts(message: ConsumeMessage): number {
    const attempts = message.properties.headers?.['x-attempts'];
    return typeof attempts === 'number' ? attempts : Number(attempts || 0);
  }
}
