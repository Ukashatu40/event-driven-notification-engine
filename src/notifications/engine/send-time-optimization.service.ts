// src/notifications/engine/send-time-optimization.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { REDIS_KEYS } from '../../shared/constants/redis-keys';
import { CRITICAL_EVENTS, EventType } from '../../shared/constants/event-types';
import { Priority } from '../../shared/constants/priorities';

export interface SendTimeDecision {
  optimize: boolean;
  targetHour?: number; // 0-23 in user's local time
  delayMs?: number;
  reason: string;
}

/**
 * Send-time optimization (STO).
 *
 * Tracks per-user, per-hour engagement scores in a Redis hash:
 * user:{userId}:engagement -> { "0": score, "1": score, ..., "23": score }
 *
 * A score increments on every READ event, weighted by recency (exponential
 * decay favors recent behavior over stale history). After enough data points,
 * the engine picks the hour with the highest score as the user's preferred
 * delivery window for non-urgent notifications.
 *
 * Bypass conditions (always send immediately):
 * - CRITICAL events (margin calls, circuit breakers) — latency SLA matters more
 *   than open-rate optimization
 * - Insufficient data (< MIN_SAMPLES read events recorded)
 * - Target hour is more than MAX_DELAY_HOURS away (avoid stale-feeling alerts)
 */
@Injectable()
export class SendTimeOptimizationService {
  private readonly logger = new Logger(SendTimeOptimizationService.name);

  private readonly MIN_SAMPLES = 10;
  private readonly MAX_DELAY_HOURS = 4;
  private readonly DECAY_FACTOR = 0.9; // older reads count for less each time

  constructor(private readonly redis: RedisService) {}

  /**
   * Records an engagement event (user read/opened a notification).
   * Call this from the read-receipt webhook handler.
   */
  async recordEngagement(
    userId: string,
    readAt: Date = new Date(),
  ): Promise<void> {
    this.logger.debug('Debugging');
    const hour = readAt.getHours();
    const key = REDIS_KEYS.sendTimeScores(userId);

    const current = await this.redis.hget(key, hour.toString());
    const currentScore = parseFloat(current ?? '0');

    // Apply decay to all other hours so the distribution stays "fresh" --
    // recent behavior should outweigh behavior from months ago
    const allScores = await this.redis.hgetall(key);
    const pipeline = this.redis.getClient().pipeline();

    for (const [h, score] of Object.entries(allScores)) {
      if (h === hour.toString()) continue;
      const decayed = parseFloat(score) * this.DECAY_FACTOR;
      pipeline.hset(key, h, decayed.toString());
    }

    pipeline.hset(key, hour.toString(), (currentScore + 1).toString());
    pipeline.expire(key, 180 * 24 * 60 * 60); // 180-day rolling window
    await pipeline.exec();
  }

  /**
   * Decides whether to delay a notification to the user's optimal hour.
   * Returns optimize: false if the event should send immediately.
   */
  async decide(
    userId: string,
    eventType: EventType,
    priority: Priority,
    userTimezone: string,
  ): Promise<SendTimeDecision> {
    // CRITICAL events and HIGH priority always bypass STO
    if (CRITICAL_EVENTS.includes(eventType) || priority <= Priority.HIGH) {
      return { optimize: false, reason: 'PRIORITY_BYPASS' };
    }

    const scores = await this.redis.hgetall(REDIS_KEYS.sendTimeScores(userId));

    const totalSamples = Object.values(scores).reduce(
      (sum, v) => sum + parseFloat(v),
      0,
    );

    if (totalSamples < this.MIN_SAMPLES) {
      return { optimize: false, reason: 'INSUFFICIENT_DATA' };
    }

    const bestHour = this.getBestHour(scores);
    if (bestHour === null) {
      return { optimize: false, reason: 'NO_CLEAR_PREFERENCE' };
    }

    const delayMs = this.computeDelayMs(bestHour, userTimezone);
    const delayHours = delayMs / (60 * 60 * 1000);

    if (delayHours > this.MAX_DELAY_HOURS) {
      return { optimize: false, reason: 'TARGET_HOUR_TOO_FAR' };
    }

    if (delayMs <= 0) {
      return { optimize: false, reason: 'ALREADY_AT_OPTIMAL_HOUR' };
    }

    return {
      optimize: true,
      targetHour: bestHour,
      delayMs,
      reason: 'OPTIMIZED_TO_PEAK_ENGAGEMENT_HOUR',
    };
  }

  /**
   * Returns the user's top 3 engagement hours — used by the preview API
   * and analytics dashboard to show why a decision was made.
   */
  async getEngagementProfile(
    userId: string,
  ): Promise<Array<{ hour: number; score: number }>> {
    const scores = await this.redis.hgetall(REDIS_KEYS.sendTimeScores(userId));

    return Object.entries(scores)
      .map(([hour, score]) => ({
        hour: parseInt(hour, 10),
        score: parseFloat(score),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private getBestHour(scores: Record<string, string>): number | null {
    let bestHour: number | null = null;
    let bestScore = 0;

    for (const [hour, score] of Object.entries(scores)) {
      const numScore = parseFloat(score);
      if (numScore > bestScore) {
        bestScore = numScore;
        bestHour = parseInt(hour, 10);
      }
    }

    return bestHour;
  }

  /**
   * Computes milliseconds until the next occurrence of targetHour
   * in the user's local timezone. If targetHour has already passed today,
   * rolls forward to tomorrow only if that's still within MAX_DELAY_HOURS --
   * otherwise the caller's bypass check handles that case.
   */
  private computeDelayMs(targetHour: number, timezone: string): number {
    const now = new Date();
    const userNow = new Date(
      now.toLocaleString('en-US', { timeZone: timezone }),
    );

    const target = new Date(userNow);
    target.setHours(targetHour, 0, 0, 0);

    if (target <= userNow) {
      target.setDate(target.getDate() + 1);
    }

    const offsetMs = now.getTime() - userNow.getTime();
    const targetUtc = new Date(target.getTime() + offsetMs);

    return targetUtc.getTime() - now.getTime();
  }
}
