import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage, Options } from 'amqplib';

@Injectable()
export class RabbitmqService implements OnModuleInit, OnModuleDestroy {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connecting: Promise<Channel | null> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    try {
      await this.getChannel();
    } catch (error) {
      console.error('[RabbitMQ] 初始化连接失败，应用将继续启动:', error);
    }
  }

  async onModuleDestroy() {
    await this.close();
  }

  get exchange() {
    return this.configService.get<string>('rabbitmq.exchange', 'app.events');
  }

  get retryExchange() {
    return this.configService.get<string>(
      'rabbitmq.retryExchange',
      'app.events.retry',
    );
  }

  get deadLetterExchange() {
    return this.configService.get<string>(
      'rabbitmq.deadLetterExchange',
      'app.events.dlx',
    );
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
          console.error('[RabbitMQ] 消费消息异常:', queue, error);
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
          console.error('[RabbitMQ] 连接错误:', error);
          this.connection = null;
          this.channel = null;
        });

        connection.on('close', () => {
          console.warn('[RabbitMQ] 连接已关闭');
          this.connection = null;
          this.channel = null;
        });

        this.connection = connection;
        this.channel = channel;

        console.log('[RabbitMQ] connected');
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
      console.error('[RabbitMQ] 关闭连接失败:', error);
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }
}
