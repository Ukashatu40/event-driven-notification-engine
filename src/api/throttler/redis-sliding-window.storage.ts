// src/api/throttler/redis-sliding-window.storage.ts
import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '../../infrastructure/redis/redis.service';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
}

/**
 * Sliding-window rate limiting in Redis (spec A10.1.C).
 *
 * Each request is a member of a sorted set scored by its timestamp. Members
 * older than the window are trimmed, then the remaining members are counted, so
 * the limit applies to "the last N seconds" at every instant — a burst of 100
 * requests split across a window boundary is counted as 100 (a fixed window
 * would count 50 + 50 and let a 2× burst through). Because state is in Redis,
 * the limit is shared by every app replica.
 *
 * Fail-open: if Redis is unreachable the request is allowed (and logged).
 * Rate limiting protects availability; it must not take the API down with it.
 */
@Injectable()
export class RedisSlidingWindowThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisSlidingWindowThrottlerStorage.name);
  private sequence = 0;

  constructor(private readonly redis: RedisService) {}

  async increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const redisKey = `rl:${key}`;
    // Unique member even for two requests in the same millisecond.
    const member = `${now}-${process.pid}-${this.sequence++}`;

    try {
      const results = await this.redis
        .getClient()
        .multi()
        .zremrangebyscore(redisKey, 0, now - ttl)
        .zadd(redisKey, now, member)
        .zcard(redisKey)
        .zrange(redisKey, 0, 0, 'WITHSCORES')
        .pexpire(redisKey, ttl)
        .exec();

      const totalHits = Number(results?.[2]?.[1] ?? 1);
      const oldest = Number(
        (results?.[3]?.[1] as string[] | undefined)?.[1] ?? now,
      );
      // Seconds until the oldest request leaves the window and a slot frees up.
      const timeToExpire = Math.max(1, Math.ceil((oldest + ttl - now) / 1000));

      return { totalHits, timeToExpire };
    } catch (err) {
      this.logger.error(
        `Rate-limit store unavailable, allowing request: ${(err as Error).message}`,
      );
      return { totalHits: 1, timeToExpire: Math.ceil(ttl / 1000) };
    }
  }
}
