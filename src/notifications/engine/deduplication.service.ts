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
