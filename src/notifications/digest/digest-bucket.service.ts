// src/notifications/digest/digest-bucket.service.ts
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { REDIS_KEYS } from '../../shared/constants/redis-keys';

/**
 * Where a notification came from — this decides when and whether it is digested:
 *  - hourly / daily : the user chose a digest mode for the category (Day 5).
 *  - quiet          : more than 5 notifications piled up during quiet hours
 *                     (spec A6.3) — one morning digest instead of a burst.
 *  - capped         : suppressed by frequency caps; if 3 or more accumulate they
 *                     are batched into a single digest (spec Appendix B).
 */
export type DigestSource = 'hourly' | 'daily' | 'quiet' | 'capped';

export const DIGEST_SOURCES: readonly DigestSource[] = [
  'hourly',
  'daily',
  'quiet',
  'capped',
];

/** Minimum items for a digest to be worth sending, per source. */
export const DIGEST_MIN_ITEMS: Record<DigestSource, number> = {
  hourly: 1,
  daily: 1,
  quiet: 1, // already gated by the "> 5 queued" rule before it gets here
  capped: 3,
};

export interface DueBucket {
  userId: string;
  source: DigestSource;
}

/**
 * Redis storage for digests: a sorted set of notification ids per (user,
 * source), plus one global set saying which buckets are due and when. All
 * operations are single Redis commands or MULTI blocks, so several replicas can
 * share the work: a bucket is claimed with ZREM (exactly one caller gets 1) and
 * its items are taken with an atomic read-and-delete.
 */
@Injectable()
export class DigestBucketService {
  constructor(private readonly redis: RedisService) {}

  private member = (userId: string, source: DigestSource) =>
    `${userId}|${source}`;

  /** Adds a notification and makes sure the bucket has a flush time (the earliest wins). */
  async add(
    userId: string,
    source: DigestSource,
    notificationId: string,
    dueAt: Date,
  ): Promise<void> {
    const client = this.redis.getClient();
    await client
      .multi()
      .zadd(REDIS_KEYS.digestBucket(userId, source), Date.now(), notificationId)
      // LT: only ever move the due time EARLIER, never push it back
      .zadd(
        REDIS_KEYS.digestDue,
        'LT',
        'CH',
        dueAt.getTime(),
        this.member(userId, source),
      )
      .exec();
    // ZADD LT does not create a missing member when it would be a no-op on an
    // existing one, but it does add absent members — nothing more to do.
  }

  /** Claims every bucket due at `asOf`. Each bucket is returned to exactly one caller. */
  async claimDue(asOf = Date.now(), limit = 100): Promise<DueBucket[]> {
    const due = await this.redis.zrangebyscore(
      REDIS_KEYS.digestDue,
      0,
      asOf,
      limit,
    );
    const claimed: DueBucket[] = [];

    for (const member of due) {
      const won = await this.redis
        .getClient()
        .zrem(REDIS_KEYS.digestDue, member);
      if (won === 0) continue;
      const [userId, source] = member.split('|') as [string, DigestSource];
      claimed.push({ userId, source });
    }
    return claimed;
  }

  /** Atomically reads and empties a bucket. */
  async take(userId: string, source: DigestSource): Promise<string[]> {
    const key = REDIS_KEYS.digestBucket(userId, source);
    const res = await this.redis
      .getClient()
      .multi()
      .zrange(key, 0, -1)
      .del(key)
      .exec();
    return ((res?.[0]?.[1] as string[] | undefined) ?? []).filter(Boolean);
  }

  /** Puts items back (a flush that could not complete, or one deferred by quiet hours). */
  async restore(
    userId: string,
    source: DigestSource,
    ids: string[],
    dueAt: Date,
  ): Promise<void> {
    for (const id of ids) await this.add(userId, source, id, dueAt);
  }

  async size(userId: string, source: DigestSource): Promise<number> {
    return this.redis.zcount(
      REDIS_KEYS.digestBucket(userId, source),
      '-inf',
      '+inf',
    );
  }

  /** Next full hour, in UTC (hourly digests). */
  static nextHour(from = new Date()): Date {
    const d = new Date(from);
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }
}
