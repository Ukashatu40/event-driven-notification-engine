// src/compliance/dnd/dnd.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { REDIS_KEYS, TTL } from '../../shared/constants/redis-keys';
import { DndClassifierService } from './dnd-classifier.service';
import { EventType, CRITICAL_EVENTS } from '../../shared/constants/event-types';
import { maskPhone } from '../../shared/utils/pii-masker.util';

export type DndResult =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string; blockedAt: string };

/**
 * TRAI DND compliance service.
 *
 * Key architectural decision (documented in ADR-004):
 * DND check happens at the LAST possible moment before SMS dispatch,
 * NOT during routing. This closes the race condition where a user
 * registers for DND between the routing decision and actual send.
 * See Case Study C3 for why this matters.
 */
@Injectable()
export class DndService {
  private readonly logger = new Logger(DndService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly prometheus: PrometheusService,
    private readonly classifier: DndClassifierService,
  ) {}

  /**
   * Primary DND check — called immediately before every SMS dispatch.
   * Returns whether the notification is allowed to proceed.
   */
  async check(
    userId: string,
    phone: string,
    eventType: EventType,
    channel: string,
  ): Promise<DndResult> {
    // CRITICAL events bypass DND entirely — SEBI mandate supersedes TRAI
    // An audit log entry is created to document the bypass
    if (CRITICAL_EVENTS.includes(eventType)) {
      this.logger.log(
        `DND bypassed for CRITICAL event ${eventType} — user ${userId}`,
      );
      return {
        allowed: true,
        reason: 'CRITICAL_EVENT_BYPASS',
      };
    }

    // Only SMS and voice channels are subject to TRAI DND
    if (!['sms', 'voice'].includes(channel)) {
      return { allowed: true, reason: 'CHANNEL_NOT_SUBJECT_TO_DND' };
    }

    const classification = this.classifier.classify(eventType);

    // TRANSACTIONAL messages are exempt from DND
    if (classification === 'TRANSACTIONAL') {
      return { allowed: true, reason: 'TRANSACTIONAL_EXEMPT' };
    }

    // PROMOTIONAL — must check DND registry
    const isDndRegistered = await this.isDndRegistered(phone);

    if (isDndRegistered) {
      this.prometheus.recordDndBlock(classification);

      this.logger.warn(
        `DND block: user ${userId} phone ${maskPhone(phone)} is DND registered`,
      );

      return {
        allowed: false,
        reason: 'DND_REGISTERED_PROMOTIONAL_BLOCKED',
        blockedAt: new Date().toISOString(),
      };
    }

    return { allowed: true, reason: 'NOT_DND_REGISTERED' };
  }

  /**
   * Checks local Redis cache first (TTL: 24h).
   * Falls back to database if cache miss.
   * Cache is refreshed daily via a scheduled job.
   */
  private async isDndRegistered(phone: string): Promise<boolean> {
    const cacheKey = REDIS_KEYS.dndStatus(phone);

    // Cache hit
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached === 'registered';
    }

    // Cache miss — check database
    const user = await this.prisma.user.findFirst({
      where: { phone },
      select: { dndStatus: true },
    });

    const isRegistered = user?.dndStatus === 'REGISTERED';

    // Populate cache
    await this.redis.set(
      cacheKey,
      isRegistered ? 'registered' : 'not_registered',
      TTL.DND,
    );

    return isRegistered;
  }

  /**
   * Updates DND status for a user.
   * Called when user registers/deregisters from DND.
   * Immediately invalidates cache so next check reflects new status.
   */
  async updateDndStatus(
    userId: string,
    phone: string,
    registered: boolean,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { dndStatus: registered ? 'REGISTERED' : 'NOT_REGISTERED' },
    });

    // Invalidate cache immediately
    await this.redis.del(REDIS_KEYS.dndStatus(phone));

    this.logger.log(
      `DND status updated for user ${userId}: ${registered ? 'REGISTERED' : 'NOT_REGISTERED'}`,
    );
  }

  /**
   * Refreshes DND cache for a batch of phone numbers.
   * Called by the daily scheduled job.
   */
  async refreshDndCache(phones: string[]): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { phone: { in: phones } },
      select: { phone: true, dndStatus: true },
    });

    const pipeline = this.redis.getClient().pipeline();

    for (const user of users) {
      const key = REDIS_KEYS.dndStatus(user.phone);
      const value =
        user.dndStatus === 'REGISTERED' ? 'registered' : 'not_registered';
      pipeline.setex(key, TTL.DND, value);
    }

    await pipeline.exec();

    this.logger.log(`DND cache refreshed for ${users.length} users`);
  }
}
