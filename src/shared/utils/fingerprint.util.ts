// src/shared/utils/fingerprint.util.ts

import { createHash } from 'crypto';

/**
 * Generates a deterministic fingerprint for event deduplication.
 * Same event arriving twice within the dedup window produces the same fingerprint.
 *
 * Window is rounded to the nearest 5-minute bucket so that:
 * - 500 duplicate price alerts in 10 seconds → same fingerprint → 1 notification
 * - Legitimate new alert 6 minutes later → different fingerprint → new notification
 */

export function generateEventFingerprint(
  eventType: string,
  sourceEntityId: string, // e.g. stock symbol, userId, orderId
  windowBucketMs: number = 5 * 60 * 1_000, // 5-minute default window
): string {
  const windowTs = Math.floor(Date.now() / windowBucketMs) * windowBucketMs;
  const raw = `${eventType}:${sourceEntityId}:${windowTs}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function generateNotificationFingerprint(
  userId: string,
  eventType: string,
  channel: string,
  windowBucketMs: number = 5 * 60 * 1_000,
): string {
  const windowTs = Math.floor(Date.now() / windowBucketMs) * windowBucketMs;
  const raw = `${userId}:${eventType}:${channel}:${windowTs}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function generateIdempotencyKey(
  userId: string,
  eventType: string,
  eventId: string,
): string {
  const raw = `${userId}:${eventType}:${eventId}`;
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * The "source entity" an event is deduplicated on, scoped to the user.
 *
 * - price/market events → the symbol (500 duplicate RELIANCE alerts → 1)
 * - order events → the order id
 * - payments → the provider reference
 * - anything else → the event's own id
 *
 * The last fallback matters: it must identify THIS event. A constant here
 * would make any two same-type events for a user inside the dedup window
 * (e.g. two deposits, two margin calls) look like duplicates and silently drop
 * the second one. Exact repeats are still caught by the idempotency key.
 */
export function dedupSourceEntity(
  userId: string,
  payload: Record<string, unknown>,
  eventId: string,
): string {
  const entity =
    payload['symbol'] ?? payload['order_id'] ?? payload['reference'] ?? eventId;
  return `${userId}:${String(entity)}`;
}
