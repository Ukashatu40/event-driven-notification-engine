// src/preferences/preference-cache.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../infrastructure/redis/redis.service';
import { REDIS_KEYS, TTL } from '../shared/constants/redis-keys';

/**
 * Thin cache layer over user preferences.
 *
 * Preferences are read on EVERY notification — at 2M+ daily that is
 * potentially millions of DB reads. Caching in Redis with a 1-hour TTL
 * reduces database load by ~95%.
 *
 * Cache invalidation strategy:
 * - On any PUT /preferences call, the cache entry is deleted immediately.
 * - Next read repopulates from DB.
 * - TTL ensures stale data never persists beyond 1 hour even if
 *   invalidation somehow fails.
 */
@Injectable()
export class PreferenceCacheService {
  private readonly logger = new Logger(PreferenceCacheService.name);

  constructor(private readonly redis: RedisService) {}

  async get<T>(userId: string): Promise<T | null> {
    return this.redis.getJson<T>(REDIS_KEYS.userPrefs(userId));
  }

  async set<T>(userId: string, prefs: T): Promise<void> {
    await this.redis.setJson(
      REDIS_KEYS.userPrefs(userId),
      prefs,
      TTL.USER_PREFS,
    );
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.userPrefs(userId));
    this.logger.log(`Preference cache invalidated for user ${userId}`);
  }
}
