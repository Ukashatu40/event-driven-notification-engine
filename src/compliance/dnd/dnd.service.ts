// src/compliance/dnd/dnd.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { REDIS_KEYS, TTL } from '../../shared/constants/redis-keys';
import {
  DndClassifierService,
  MessageClassification,
} from './dnd-classifier.service';
import { EventType, CRITICAL_EVENTS } from '../../shared/constants/event-types';
import { maskPhone } from '../../shared/utils/pii-masker.util';

/** What the DND registry said at check time (persisted for the TRAI audit trail). */
export type DndRegistryStatus =
  | 'REGISTERED'
  | 'NOT_REGISTERED'
  | 'NOT_CHECKED' // channel is not subject to DND
  | 'UNKNOWN'; // registry lookup failed

export interface DndResult {
  allowed: boolean;
  reason: string;
  classification: MessageClassification;
  registryStatus: DndRegistryStatus;
  /** ISO timestamp of the check — proves DND was evaluated at dispatch time. */
  checkedAt: string;
  /** True when a CRITICAL/regulatory message went out despite DND registration. */
  regulatoryOverride: boolean;
  /** True when the registry could not be consulted and the decision failed closed. */
  registryUnavailable: boolean;
}

/**
 * TRAI/NCC DND compliance service.
 *
 * Key architectural decision (documented in ADR-004):
 * DND check happens at the LAST possible moment before SMS dispatch
 * (DeliveryService.process), NOT during routing. This closes the race
 * condition where a user registers for DND between the routing decision
 * and actual send. See Case Study C3 for why this matters.
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
   *
   * The registry is consulted for EVERY SMS (not only promotional ones) so the
   * audit record proves the status was checked; the policy decision is then:
   *   - CRITICAL / TRANSACTIONAL → always allowed (regulatory mandate)
   *   - PROMOTIONAL → blocked when registered, and blocked (fail closed) when
   *     the registry cannot be reached — a missed promo is cheap, a DND
   *     violation is not.
   */
  async check(
    userId: string,
    phone: string,
    eventType: EventType,
    channel: string,
  ): Promise<DndResult> {
    const classification = this.classifier.classify(eventType);
    const checkedAt = new Date().toISOString();

    // Only SMS and voice channels are subject to DND
    if (!['sms', 'voice'].includes(channel)) {
      return {
        allowed: true,
        reason: 'CHANNEL_NOT_SUBJECT_TO_DND',
        classification,
        registryStatus: 'NOT_CHECKED',
        checkedAt,
        regulatoryOverride: false,
        registryUnavailable: false,
      };
    }

    let registryStatus: DndRegistryStatus;
    try {
      registryStatus = (await this.isDndRegistered(userId))
        ? 'REGISTERED'
        : 'NOT_REGISTERED';
    } catch (err) {
      registryStatus = 'UNKNOWN';
      this.logger.error(
        `DND registry lookup failed for user ${userId}: ${(err as Error).message}`,
      );
    }

    const base = {
      classification,
      registryStatus,
      checkedAt,
      registryUnavailable: registryStatus === 'UNKNOWN',
    };

    // CRITICAL events bypass DND entirely — regulatory mandate supersedes DND.
    if (CRITICAL_EVENTS.includes(eventType)) {
      this.logger.log(
        `DND bypassed for CRITICAL event ${eventType} — user ${userId} (${registryStatus})`,
      );
      return {
        ...base,
        allowed: true,
        reason: 'CRITICAL_EVENT_BYPASS',
        regulatoryOverride: registryStatus === 'REGISTERED',
      };
    }

    // TRANSACTIONAL messages are exempt from DND
    if (classification === 'TRANSACTIONAL') {
      return {
        ...base,
        allowed: true,
        reason: 'TRANSACTIONAL_EXEMPT',
        regulatoryOverride: false,
      };
    }

    // PROMOTIONAL — registry decides; unknown fails closed.
    if (registryStatus === 'UNKNOWN') {
      return {
        ...base,
        allowed: false,
        reason: 'DND_CHECK_UNAVAILABLE',
        regulatoryOverride: false,
      };
    }

    if (registryStatus === 'REGISTERED') {
      this.prometheus.recordDndBlock(classification);
      this.logger.warn(
        `DND block: user ${userId} phone ${maskPhone(phone)} is DND registered`,
      );
      return {
        ...base,
        allowed: false,
        reason: 'DND_REGISTERED_PROMOTIONAL_BLOCKED',
        regulatoryOverride: false,
      };
    }

    return {
      ...base,
      allowed: true,
      reason: 'NOT_DND_REGISTERED',
      regulatoryOverride: false,
    };
  }

  /**
   * Checks local Redis cache first (TTL: 24h).
   * Falls back to database if cache miss.
   * Cache is refreshed daily via a scheduled job.
   */
  private async isDndRegistered(userId: string): Promise<boolean> {
    const cacheKey = REDIS_KEYS.dndStatus(userId);

    // Cache hit
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached === 'registered';
    }

    // Cache miss — check database
    // Looked up by id (not phone) so this keeps working when phone is
    // stored encrypted at rest.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
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
  async updateDndStatus(userId: string, registered: boolean): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { dndStatus: registered ? 'REGISTERED' : 'NOT_REGISTERED' },
    });

    // Invalidate cache immediately
    await this.redis.del(REDIS_KEYS.dndStatus(userId));

    this.logger.log(
      `DND status updated for user ${userId}: ${registered ? 'REGISTERED' : 'NOT_REGISTERED'}`,
    );
  }

  /**
   * Refreshes the DND cache for a batch of users.
   * Called by the daily scheduled job.
   */
  async refreshDndCache(userIds: string[]): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, dndStatus: true },
    });

    const pipeline = this.redis.getClient().pipeline();

    for (const user of users) {
      const key = REDIS_KEYS.dndStatus(user.id);
      const value =
        user.dndStatus === 'REGISTERED' ? 'registered' : 'not_registered';
      pipeline.setex(key, TTL.DND, value);
    }

    await pipeline.exec();

    this.logger.log(`DND cache refreshed for ${users.length} users`);
  }
}
