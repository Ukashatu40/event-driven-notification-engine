// src/infrastructure/redis/redis.service.ts
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      password: this.configService.get<string>('redis.password'),
      db: this.configService.get<number>('redis.db'),
      connectTimeout: this.configService.get<number>('redis.connectTimeout'),
      commandTimeout: this.configService.get<number>('redis.commandTimeout'),
      maxRetriesPerRequest: this.configService.get<number>(
        'redis.maxRetriesPerRequest',
      ),
      // ioredis wants a tls options object, not a boolean; {} means "use TLS
      // with the defaults" (host-based SNI, standard cert verification).
      tls: this.configService.get<boolean>('redis.tls') ? {} : undefined,
      lazyConnect: false,
      keepAlive: 30_000,
      enableReadyCheck: true,
      retryStrategy: (times: number) => {
        // Exponential backoff — cap at 30 seconds
        const delay = Math.min(times * 500, 30_000);
        this.logger.warn(`Redis retry attempt ${times}, delay ${delay}ms`);
        return delay;
      },
    });
  }

  async onModuleInit(): Promise<void> {
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err: Error) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
    this.client.on('reconnecting', () =>
      this.logger.warn('Redis reconnecting...'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis disconnected');
  }

  // ── Core access ──────────────────────────────────────────────────

  getClient(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  // ── Atomic increment — core of frequency capping ─────────────────

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    const pipeline = this.client.pipeline();
    pipeline.incr(key);
    if (ttlSeconds) {
      pipeline.expire(key, ttlSeconds, 'NX'); // NX = only set if not already set
    }
    const results = await pipeline.exec();
    // results[0] = [error, incrementedValue]
    const value = results?.[0]?.[1] as number;
    return value ?? 0;
  }

  // ── Sorted sets — used for retry queue and quiet-hours queue ──────

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.client.zadd(key, score, member);
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    limit?: number,
  ): Promise<string[]> {
    if (limit !== undefined) {
      return this.client.zrangebyscore(key, min, max, 'LIMIT', 0, limit);
    }
    return this.client.zrangebyscore(key, min, max);
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.client.zrem(key, member);
  }

  async zcount(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number> {
    return this.client.zcount(key, min, max);
  }

  // ── Hash — used for user engagement feature store ─────────────────

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  // ── JSON helpers — wraps get/set with JSON serialization ──────────

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      this.logger.error(`Failed to parse JSON for key: ${key}`);
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.set(key, serialized, ttlSeconds);
  }

  // ── Lua script execution — for atomic multi-step operations ───────

  async eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    return this.client.eval(script, numkeys, ...args);
  }

  // ── Health check — used by /health endpoint ───────────────────────

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
