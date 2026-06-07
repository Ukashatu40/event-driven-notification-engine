// src/analytics/realtime-counters.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../infrastructure/redis/redis.service';

/**
 * Real-time sliding window counters for analytics.
 *
 * Uses Redis sorted sets with timestamps as scores.
 * Each entry in the set is: `${identifier}:${timestamp}`
 * ZREMRANGEBYSCORE prunes entries outside the window.
 *
 * This gives exact counts within any rolling time window
 * without double-counting — required for the < 30 second
 * analytics lag target in spec Section A7.2.
 */
@Injectable()
export class RealtimeCountersService {
  private readonly logger = new Logger(RealtimeCountersService.name);

  constructor(private readonly redis: RedisService) {}

  async increment(
    metric: string,
    labels: Record<string, string>,
    windowSeconds: number = 3600, // default 1 hour window
  ): Promise<void> {
    this.logger.debug(
      `Incrementing counter for metric=${metric} labels=${JSON.stringify(
        labels,
      )} window=${windowSeconds}s`,
    );
    const key = this.buildKey(metric, labels);
    const now = Date.now();
    const member = `${now}:${Math.random()}`;

    await this.redis.zadd(key, now, member);

    // Prune entries outside the window
    await this.redis
      .getClient()
      .zremrangebyscore(key, '-inf', now - windowSeconds * 1000);

    // Set TTL slightly longer than window so key auto-expires (TTL full form means Time To Live)
    await this.redis.getClient().expire(key, windowSeconds + 60);
  }

  async getCount(
    metric: string,
    labels: Record<string, string>,
    windowSeconds: number = 3600,
  ): Promise<number> {
    const key = this.buildKey(metric, labels);
    const windowStart = Date.now() - windowSeconds * 1000;

    return this.redis.zcount(key, windowStart, '+inf');
  }

  async getRate(
    metric: string,
    labels: Record<string, string>,
    windowSeconds: number = 3600,
  ): Promise<number> {
    const count = await this.getCount(metric, labels, windowSeconds);
    return count / (windowSeconds / 3600); // per hour rate
  }

  private buildKey(metric: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `analytics:${metric}:${labelStr}`;
  }
}
