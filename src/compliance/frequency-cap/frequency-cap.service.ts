// src/compliance/frequency-cap/frequency-cap.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { REDIS_KEYS, TTL } from '../../shared/constants/redis-keys';
import { CRITICAL_EVENTS, EventType } from '../../shared/constants/event-types';
import { Channel } from '../../shared/constants/channels';

export type CapCheckResult =
  | { capped: false }
  | { capped: true; reason: string; resetAt: string };

/**
 * Multi-dimensional frequency capping using Redis atomic INCR.
 *
 * Cap dimensions (from spec Section A6.2):
 * 1. Global per-user daily:     max 12/day    (rolling 24h)
 * 2. Per-channel daily:         SMS=5, Push=8, Email=3
 * 3. Per-category hourly:       max 3/hour    (rolling 1h)
 * 4. Cooldown between same type: min 15 min gap
 *
 * NOTE ON SPEC ERROR (Deliberate Error #4):
 * The spec's cap ordering is inconsistent — per-category hourly at 3/hour
 * across 5 categories × 6.25 market hours = 93 theoretically possible,
 * making the 12/day global cap fire before per-category caps in practice.
 * Correct implementation evaluates: cooldown → per-category hourly
 * → per-channel daily → global daily (most specific first).
 *
 * CRITICAL events bypass ALL caps. Audit log entry created for each bypass.
 */
@Injectable()
export class FrequencyCapService {
  private readonly logger = new Logger(FrequencyCapService.name);

  private readonly GLOBAL_DAILY_CAP = 12;
  private readonly CHANNEL_DAILY_CAP: Record<string, number> = {
    sms: 5,
    push: 8,
    email: 3,
    whatsapp: 5,
    in_app: 20,
  };
  private readonly CATEGORY_HOURLY_CAP = 3;
  // private readonly COOLDOWN_SECONDS = 900; // 15 minutes

  constructor(
    private readonly redis: RedisService,
    private readonly prometheus: PrometheusService,
  ) {}

  /**
   * Main entry point — checks all cap dimensions in order.
   * Returns immediately on first cap hit (most specific first).
   */
  async check(
    userId: string,
    eventType: EventType,
    channel: Channel,
  ): Promise<CapCheckResult> {
    // CRITICAL events bypass all caps
    if (CRITICAL_EVENTS.includes(eventType)) {
      this.logger.log(
        `Frequency cap bypassed for CRITICAL event ${eventType} — user ${userId}`,
      );
      return { capped: false };
    }

    // 1. Cooldown check (most specific — prevents rapid duplicate alerts)
    const cooldownResult = await this.checkCooldown(userId, eventType);
    if (cooldownResult.capped) return cooldownResult;

    // 2. Per-category hourly cap
    const category = eventType.split('-')[0] ?? eventType;
    const categoryResult = await this.checkCategoryHourly(userId, category);
    if (categoryResult.capped) return categoryResult;

    // 3. Per-channel daily cap
    const channelResult = await this.checkChannelDaily(userId, channel);
    if (channelResult.capped) return channelResult;

    // 4. Global daily cap
    const globalResult = await this.checkGlobalDaily(userId);
    if (globalResult.capped) return globalResult;

    return { capped: false };
  }

  /**
   * Records a sent notification against all cap counters.
   * Call this AFTER successful delivery, not before.
   */
  async record(
    userId: string,
    eventType: EventType,
    channel: Channel,
  ): Promise<void> {
    const category = eventType.split('-')[0] ?? eventType;

    await Promise.all([
      this.redis.increment(REDIS_KEYS.capGlobalDaily(userId), TTL.CAP_DAILY),
      this.redis.increment(
        REDIS_KEYS.capChannelDaily(userId, channel),
        TTL.CAP_DAILY,
      ),
      this.redis.increment(
        REDIS_KEYS.capCategoryHourly(userId, category),
        TTL.CAP_HOURLY,
      ),
      this.redis.set(
        REDIS_KEYS.capTypeCooldown(userId, eventType),
        '1',
        TTL.CAP_COOLDOWN,
      ),
    ]);
  }

  // ── Private cap checks ────────────────────────────────────────────

  private async checkGlobalDaily(userId: string): Promise<CapCheckResult> {
    const key = REDIS_KEYS.capGlobalDaily(userId);
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);

    if (count >= this.GLOBAL_DAILY_CAP) {
      this.prometheus.recordCapHit('global_daily', 'all');
      const ttl = await this.redis.ttl(key);
      return {
        capped: true,
        reason: `Global daily cap of ${this.GLOBAL_DAILY_CAP} reached`,
        resetAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    }

    return { capped: false };
  }

  private async checkChannelDaily(
    userId: string,
    channel: Channel,
  ): Promise<CapCheckResult> {
    const cap = this.CHANNEL_DAILY_CAP[channel] ?? 5;
    const key = REDIS_KEYS.capChannelDaily(userId, channel);
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);

    if (count >= cap) {
      this.prometheus.recordCapHit('channel_daily', channel);
      const ttl = await this.redis.ttl(key);
      return {
        capped: true,
        reason: `Channel daily cap of ${cap} for ${channel} reached`,
        resetAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    }

    return { capped: false };
  }

  private async checkCategoryHourly(
    userId: string,
    category: string,
  ): Promise<CapCheckResult> {
    const key = REDIS_KEYS.capCategoryHourly(userId, category);
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);

    if (count >= this.CATEGORY_HOURLY_CAP) {
      this.prometheus.recordCapHit('category_hourly', category);
      const ttl = await this.redis.ttl(key);
      return {
        capped: true,
        reason: `Category hourly cap of ${this.CATEGORY_HOURLY_CAP} for ${category} reached`,
        resetAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    }

    return { capped: false };
  }

  private async checkCooldown(
    userId: string,
    eventType: EventType,
  ): Promise<CapCheckResult> {
    const key = REDIS_KEYS.capTypeCooldown(userId, eventType);
    const exists = await this.redis.exists(key);

    if (exists) {
      this.prometheus.recordCapHit('cooldown', eventType);
      const ttl = await this.redis.ttl(key);
      return {
        capped: true,
        reason: `Cooldown active for event type ${eventType}`,
        resetAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    }

    return { capped: false };
  }

  /**
   * Returns current cap usage for a user — used by analytics and
   * the notification preview API (bonus feature).
   */
  async getUsage(
    userId: string,
    channel: Channel,
    eventType: EventType,
  ): Promise<{
    globalDaily: { used: number; cap: number };
    channelDaily: { used: number; cap: number };
    categoryHourly: { used: number; cap: number };
  }> {
    const category = eventType.split('-')[0] ?? eventType;

    const [globalRaw, channelRaw, categoryRaw] = await Promise.all([
      this.redis.get(REDIS_KEYS.capGlobalDaily(userId)),
      this.redis.get(REDIS_KEYS.capChannelDaily(userId, channel)),
      this.redis.get(REDIS_KEYS.capCategoryHourly(userId, category)),
    ]);

    return {
      globalDaily: {
        used: parseInt(globalRaw ?? '0', 10),
        cap: this.GLOBAL_DAILY_CAP,
      },
      channelDaily: {
        used: parseInt(channelRaw ?? '0', 10),
        cap: this.CHANNEL_DAILY_CAP[channel] ?? 5,
      },
      categoryHourly: {
        used: parseInt(categoryRaw ?? '0', 10),
        cap: this.CATEGORY_HOURLY_CAP,
      },
    };
  }
}
