// src/notifications/engine/deduplication.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { REDIS_KEYS, TTL } from '../../shared/constants/redis-keys';
import {
  generateEventFingerprint,
  generateIdempotencyKey,
} from '../../shared/utils/fingerprint.util';

export interface DeduplicationResult {
  isDuplicate: boolean;
  existingNotificationId?: string;
  reason?: string;
}

/**
 * Two-layer deduplication:
 *
 * Layer 1 — Idempotency key (caller-supplied):
 *   If the producer sends the same idempotencyKey twice,
 *   we return the original notificationId. 24h TTL.
 *
 * Layer 2 — Event fingerprint (system-generated):
 *   SHA-256 of (eventType + sourceEntityId + 5-min time bucket).
 *   Prevents 500 duplicate price alerts from the same stock
 *   in a 5-minute window from triggering 500 notifications.
 *   5-min TTL.
 *
 * This is the solution to Challenge B2.4 (Notification Storm).
 */

@Injectable()
export class DeduplicationService {
  private readonly logger = new Logger(DeduplicationService.name);

  constructor(private readonly redis: RedisService) {}

  async check(
    idempotencyKey: string | undefined,
    eventType: string,
    _userId: string,
    sourceEntityId: string,
  ): Promise<DeduplicationResult> {
    // Layer 1: idempotency key check
    if (idempotencyKey) {
      const key = REDIS_KEYS.idempotency(idempotencyKey);
      const existing = await this.redis.get(key);

      if (existing) {
        this.logger.debug(
          `Duplicate detected via idempotency key: ${idempotencyKey}`,
        );
        return {
          isDuplicate: true,
          existingNotificationId: existing,
          reason: 'IDEMPOTENCY_KEY_DUPLICATE',
        };
      }
    }

    // Layer 2: fingerprint check
    const fingerprint = generateEventFingerprint(eventType, sourceEntityId);
    const fingerprintKey = REDIS_KEYS.dedup(fingerprint);
    const existingFingerprint = await this.redis.get(fingerprintKey);

    if (existingFingerprint) {
      this.logger.debug(
        `Duplicate detected via fingerprint for ${eventType}:${sourceEntityId}`,
      );
      return {
        isDuplicate: true,
        existingNotificationId: existingFingerprint,
        reason: 'FINGERPRINT_DUPLICATE',
      };
    }

    return { isDuplicate: false };
  }

  /**
   * Atomically claims the idempotency key and the event fingerprint for
   * `notificationId` (SET NX). If either is already held by a different
   * notification, nothing this call took is kept and the original id is
   * returned, so two concurrent identical requests can never both proceed.
   * Claiming the same id again is a no-op (safe for Kafka redelivery).
   */
  async claim(
    notificationId: string,
    idempotencyKey: string | undefined,
    eventType: string,
    sourceEntityId: string,
  ): Promise<DeduplicationResult> {
    const client = this.redis.getClient();
    const wanted: Array<{ key: string; ttl: number; reason: string }> = [];

    if (idempotencyKey) {
      wanted.push({
        key: REDIS_KEYS.idempotency(idempotencyKey),
        ttl: TTL.IDEMPOTENCY,
        reason: 'IDEMPOTENCY_KEY_DUPLICATE',
      });
    }
    wanted.push({
      key: REDIS_KEYS.dedup(
        generateEventFingerprint(eventType, sourceEntityId),
      ),
      ttl: TTL.DEDUP,
      reason: 'FINGERPRINT_DUPLICATE',
    });

    const taken: string[] = [];
    for (const { key, ttl, reason } of wanted) {
      const ok = await client.set(key, notificationId, 'EX', ttl, 'NX');
      if (ok === 'OK') {
        taken.push(key);
        continue;
      }
      const holder = await client.get(key);
      if (holder === notificationId) continue; // our own earlier claim
      if (taken.length) await client.del(...taken);
      return {
        isDuplicate: true,
        existingNotificationId: holder ?? undefined,
        reason,
      };
    }
    return { isDuplicate: false };
  }

  /** Gives a claim back (e.g. the event could not be published). */
  async release(
    notificationId: string,
    idempotencyKey: string | undefined,
    eventType: string,
    sourceEntityId: string,
  ): Promise<void> {
    const client = this.redis.getClient();
    const keys = [
      ...(idempotencyKey ? [REDIS_KEYS.idempotency(idempotencyKey)] : []),
      REDIS_KEYS.dedup(generateEventFingerprint(eventType, sourceEntityId)),
    ];
    for (const key of keys) {
      if ((await client.get(key)) === notificationId) await client.del(key);
    }
  }

  async register(
    notificationId: string,
    idempotencyKey: string | undefined,
    eventType: string,
    userId: string,
    sourceEntityId: string,
  ): Promise<void> {
    const ops: Promise<void>[] = [];

    if (idempotencyKey) {
      ops.push(
        this.redis.set(
          REDIS_KEYS.idempotency(idempotencyKey),
          notificationId,
          TTL.IDEMPOTENCY,
        ),
      );
    }

    const fingerprint = generateEventFingerprint(eventType, sourceEntityId);
    ops.push(
      this.redis.set(REDIS_KEYS.dedup(fingerprint), notificationId, TTL.DEDUP),
    );

    const computedKey = generateIdempotencyKey(
      userId,
      eventType,
      sourceEntityId,
    );
    ops.push(
      this.redis.set(
        REDIS_KEYS.idempotency(computedKey),
        notificationId,
        TTL.IDEMPOTENCY,
      ),
    );

    await Promise.all(ops);
  }
}
