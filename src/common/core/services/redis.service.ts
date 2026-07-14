import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;
  private publisher: Redis;
  private subscriber: Redis;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private async connect() {
    const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6379);
    const redisPassword = this.configService.get<string>('REDIS_PASSWORD');
    const redisDb = this.configService.get<number>('REDIS_DB', 0);

    const redisConfig = {
      host: redisHost,
      port: redisPort,
      db: redisDb,
      lazyConnect: false,
      keepAlive: 30000,
      // 重试策略：每次重试间隔递增，最多 3 秒
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 100, 3000);
        if (times > 10) {
          this.logger.error({
            event: 'redis.reconnect_exhausted',
            attempts: times,
            delayMs: delay,
          });
          return null; // 10 次后停止重试
        }
        return delay;
      },
      // 每个请求最大重试次数：null 表示无限重试（直到连接恢复）
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      // 连接超时
      connectTimeout: 10000,
      reconnectOnError: (err: Error) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          // 只在特定错误时重连
          return true;
        }
        // 对于连接相关的错误，也尝试重连
        if (err.message.includes('ECONNRESET') ||
            err.message.includes('ECONNREFUSED') ||
            err.message.includes('ETIMEDOUT') ||
            err.message.includes('RECONNECTIONFAILED')) {
          return true;
        }
        return false;
      },
    };
    this.logger.debug({
      event: 'redis.configured',
      host: redisHost,
      port: redisPort,
      db: redisDb,
    });
    if (redisPassword) {
      this.client = new Redis({
        ...redisConfig,
        password: redisPassword,
      });
      this.publisher = new Redis({
        ...redisConfig,
        password: redisPassword,
      });
      this.subscriber = new Redis({
        ...redisConfig,
        password: redisPassword,
      });
    } else {
      this.client = new Redis(redisConfig);
      this.publisher = new Redis(redisConfig);
      this.subscriber = new Redis(redisConfig);
    }

    // 为所有连接添加事件监听
    this.setupEventListeners(this.client, 'client');
    this.setupEventListeners(this.publisher, 'publisher');
    this.setupEventListeners(this.subscriber, 'subscriber');
  }

  private setupEventListeners(redisInstance: Redis, name: string) {
    redisInstance.on('connect', () => {
      this.logger.log({ event: 'redis.connected', connection: name });
    });

    redisInstance.on('ready', () => {
      this.logger.log({ event: 'redis.ready', connection: name });
    });

    redisInstance.on('error', (err) => {
      this.logger.error({
        event: 'redis.error',
        connection: name,
        err,
      });
    });

    redisInstance.on('close', () => {
      this.logger.warn({ event: 'redis.closed', connection: name });
    });

    redisInstance.on('reconnecting', (params: { delay: number; attempt: number }) => {
      this.logger.warn({
        event: 'redis.reconnecting',
        connection: name,
        attempts: params.attempt,
        delayMs: params.delay,
      });
    });

    redisInstance.on('end', () => {
      this.logger.warn({ event: 'redis.ended', connection: name });
    });

    // 监听 subscriber 的消息事件
    if (name === 'subscriber') {
      redisInstance.on('message', (channel, message) => {
        this.logger.debug({
          event: 'redis.message_received',
          channel,
          messageLength: message.length,
        });
      });
    }
  }

  private async disconnect() {
    if (this.client) {
      await this.client.quit();
    }
    if (this.publisher) {
      await this.publisher.quit();
    }
    if (this.subscriber) {
      await this.subscriber.quit();
    }
  }

  // 获取客户端实例（用于特殊场景）
  getClient(): Redis {
    return this.client;
  }

  getPublisher(): Redis {
    return this.publisher;
  }

  getSubscriber(): Redis {
    return this.subscriber;
  }

  // ========== 常用 Redis 操作 ==========

  // 设置键值
  async set(key: string, value: string | number | Buffer, ttl?: number): Promise<'OK'> {
    if (ttl) {
      return this.client.set(key, value, 'EX', ttl);
    }
    return this.client.set(key, value);
  }

  // 获取键值
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  // 删除键
  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  // 检查键是否存在
  async exists(key: string): Promise<number> {
    return this.client.exists(key);
  }

  // 设置过期时间
  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  // 获取键的剩余过期时间
  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  // ========== Hash 操作 ==========

  // 设置 hash 字段
  async hset(key: string, field: string, value: string): Promise<number> {
    return this.client.hset(key, field, value);
  }

  // 获取 hash 字段
  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  // 获取所有 hash 字段
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  // 删除 hash 字段
  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.client.hdel(key, ...fields);
  }

  // ========== List 操作 ==========

  // 从列表左侧推入值
  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values);
  }

  // 从列表右侧推入值
  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.client.rpush(key, ...values);
  }

  // 从列表左侧弹出值
  async lpop(key: string): Promise<string | null> {
    return this.client.lpop(key);
  }

  // 从列表右侧弹出值
  async rpop(key: string): Promise<string | null> {
    return this.client.rpop(key);
  }

  // 获取列表范围内的元素
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  // ========== Set 操作 ==========

  // 向集合添加元素
  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.client.sadd(key, ...members);
  }

  // 获取集合所有成员
  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  // 检查元素是否在集合中
  async sismember(key: string, member: string): Promise<number> {
    return this.client.sismember(key, member);
  }

  // 从集合移除元素
  async srem(key: string, ...members: string[]): Promise<number> {
    return this.client.srem(key, ...members);
  }

  // ========== Sorted Set 操作 ==========

  // 向有序集合添加元素
  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(key, score, member);
  }

  // 获取有序集合范围内的元素
  async zrange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[]> {
    if (withScores) {
      return this.client.zrange(key, start, stop, 'WITHSCORES');
    }
    return this.client.zrange(key, start, stop);
  }

  // 获取有序集合中指定成员的分数
  async zscore(key: string, member: string): Promise<string | null> {
    return this.client.zscore(key, member);
  }

  // 从有序集合移除元素
  async zrem(key: string, ...members: string[]): Promise<number> {
    return this.client.zrem(key, ...members);
  }

  // ========== 发布/订阅操作 ==========

  // 发布消息
  async publish(channel: string, message: string): Promise<number> {
    return this.publisher.publish(channel, message);
  }

  // 订阅频道
  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch, message) => {
      if (ch === channel) {
        callback(message);
      }
    });
  }

  // 取消订阅频道
  async unsubscribe(channel: string): Promise<void> {
    await this.subscriber.unsubscribe(channel);
  }

  // ========== 缓存辅助方法 ==========

  // 缓存对象（自动序列化）
  async cacheObject(key: string, obj: any, ttl?: number): Promise<'OK'> {
    const value = JSON.stringify(obj);
    return this.set(key, value, ttl);
  }

  // 获取缓存对象（自动反序列化）
  async getCachedObject<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  // 删除匹配的键
  async delPattern(pattern: string): Promise<number> {
    const keys = await this.keys(pattern);
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  // 获取匹配的键
  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  // 批量设置
  async mset(keyValues: Record<string, string>): Promise<'OK'> {
    const args: string[] = [];
    for (const [key, value] of Object.entries(keyValues)) {
      args.push(key, value);
    }
    return this.client.mset(...args);
  }

  // 批量获取
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return this.client.mget(...keys);
  }

  // 自增
  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  // 自减
  async decr(key: string): Promise<number> {
    return this.client.decr(key);
  }
}
