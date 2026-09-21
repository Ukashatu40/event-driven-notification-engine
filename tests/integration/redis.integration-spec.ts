// tests/integration/redis.integration-spec.ts
//
// The Redis-backed guarantees, proven against a REAL Redis: atomicity under
// concurrency, sliding-window semantics, and single-use refresh tokens.
import '../helpers/infra';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { DeduplicationService } from '../../src/notifications/engine/deduplication.service';
import { RedisSlidingWindowThrottlerStorage } from '../../src/api/throttler/redis-sliding-window.storage';
import { AuthService } from '../../src/auth/auth.service';
import { DigestBucketService } from '../../src/notifications/digest/digest-bucket.service';

const suite = process.env.INFRA_UP === 'true' ? describe : describe.skip;

suite('Redis guarantees (integration)', () => {
  let client: Redis;
  // Mirrors the real RedisService helpers the services call, over a real ioredis client.
  const redis = () => ({
    getClient: () => client,
    zrangebyscore: (
      key: string,
      min: number | string,
      max: number | string,
      limit?: number,
    ) =>
      limit === undefined
        ? client.zrangebyscore(key, min, max)
        : client.zrangebyscore(key, min, max, 'LIMIT', 0, limit),
    zcount: (key: string, min: number | string, max: number | string) =>
      client.zcount(key, min, max),
  });
  const prefix = `it:${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    client = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
      db: Number(process.env.REDIS_DB ?? 0),
    });
  });
  afterAll(async () => {
    const keys = await client.keys(`*${prefix}*`).catch(() => [] as string[]);
    if (keys.length) await client.del(...keys);
    await client.quit();
  });

  describe('deduplication (challenge B2.4)', () => {
    it("50 CONCURRENT identical requests → exactly ONE proceeds, 49 get the winner's id", async () => {
      const dedup = new DeduplicationService(redis() as never);
      const key = `${prefix}-idem-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          dedup.claim(`n-${i}`, key, 'MKTX-001', `u:${randomUUID()}`),
        ),
      );
      const winners = results.filter((r) => !r.isDuplicate);
      expect(winners).toHaveLength(1);
      const winnerId = new Set(
        results
          .filter((r) => r.isDuplicate)
          .map((r) => r.existingNotificationId),
      );
      expect(winnerId.size).toBe(1);
    });

    it('a burst for the same user+symbol collapses to one; another user is unaffected', async () => {
      const dedup = new DeduplicationService(redis() as never);
      const entity = `${prefix}-userA:RELIANCE`;
      const burst = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          dedup.claim(`b-${i}`, undefined, 'MKTX-001', entity),
        ),
      );
      expect(burst.filter((r) => !r.isDuplicate)).toHaveLength(1);
      expect(
        (
          await dedup.claim(
            'other',
            undefined,
            'MKTX-001',
            `${prefix}-userB:RELIANCE`,
          )
        ).isDuplicate,
      ).toBe(false);
    });

    it('sets a TTL, so a legitimate later event is not blocked forever', async () => {
      const dedup = new DeduplicationService(redis() as never);
      const key = `${prefix}-ttl-${randomUUID()}`;
      await dedup.claim('n-1', key, 'MKTX-001', `${prefix}:ttl`);
      const ttl = await client.ttl(`notif:idempotency:${key}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86_400);
    });

    it('release() frees a claim so the caller can retry', async () => {
      const dedup = new DeduplicationService(redis() as never);
      const key = `${prefix}-rel-${randomUUID()}`;
      const entity = `${prefix}:rel-${randomUUID()}`;
      await dedup.claim('n-1', key, 'RISK-001', entity);
      await dedup.release('n-1', key, 'RISK-001', entity);
      expect(
        (await dedup.claim('n-2', key, 'RISK-001', entity)).isDuplicate,
      ).toBe(false);
    });
  });

  describe('sliding-window rate limit (spec A10.1.C)', () => {
    it('allows exactly N requests in the window, then counts beyond', async () => {
      const store = new RedisSlidingWindowThrottlerStorage(redis() as never);
      const key = `${prefix}-rl-${randomUUID()}`;
      let last = 0;
      for (let i = 0; i < 100; i++)
        last = (await store.increment(key, 60_000)).totalHits;
      expect(last).toBe(100);
      expect((await store.increment(key, 60_000)).totalHits).toBe(101);
    });

    it('SLIDES: entries leave the window one at a time', async () => {
      const store = new RedisSlidingWindowThrottlerStorage(redis() as never);
      const key = `${prefix}-slide-${randomUUID()}`;
      await store.increment(key, 1000);
      await new Promise((r) => setTimeout(r, 600));
      await store.increment(key, 1000);
      await new Promise((r) => setTimeout(r, 600)); // first is now 1.2s old (out), second 0.6s (in)
      expect((await store.increment(key, 1000)).totalHits).toBe(2);
    });

    it('is shared across app instances (two storages, one limit)', async () => {
      const a = new RedisSlidingWindowThrottlerStorage(redis() as never);
      const b = new RedisSlidingWindowThrottlerStorage(redis() as never);
      const key = `${prefix}-shared-${randomUUID()}`;
      await a.increment(key, 60_000);
      await b.increment(key, 60_000);
      expect((await a.increment(key, 60_000)).totalHits).toBe(3);
    });
  });

  describe('refresh-token rotation', () => {
    const cfg = {
      'app.serviceKey': 'k',
      'app.operatorKey': '',
      'app.adminKey': '',
      'app.jwt.secret': 'a'.repeat(40),
      'app.jwt.refreshSecret': 'b'.repeat(40),
      'app.jwt.refreshExpiry': '7d',
    } as Record<string, string>;
    const auth = () =>
      new AuthService(
        { get: (k: string) => cfg[k] } as never,
        redis() as never,
      );

    it('two racing redemptions of one token: exactly one succeeds (atomic GETDEL)', async () => {
      const svc = auth();
      const pair = await svc.login('k', 'SERVICE');
      const outcomes = await Promise.allSettled([
        svc.refresh(pair.refresh_token),
        svc.refresh(pair.refresh_token),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    });
  });

  describe('digest buckets', () => {
    const svc = () => new DigestBucketService(redis() as never);
    const user = () => `${prefix}-u-${randomUUID()}`;
    const cleanup: string[] = [];
    afterEach(async () => {
      for (const k of cleanup.splice(0)) await client.del(k);
    });

    it('a due bucket is claimed by EXACTLY ONE of 20 racing replicas', async () => {
      const u = user();
      await svc().add(u, 'daily', 'n-1', new Date(Date.now() - 1000));
      const results = await Promise.all(
        Array.from({ length: 20 }, () => svc().claimDue(Date.now(), 1000)),
      );
      const mine = results.flat().filter((b) => b.userId === u);
      expect(mine).toHaveLength(1);
      cleanup.push(`notif:digest:${u}:daily`);
    });

    it('take() returns every item once and empties the bucket, even under concurrent adds', async () => {
      const u = user();
      const b = svc();
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          b.add(u, 'quiet', `n-${i}`, new Date(Date.now() + 60_000)),
        ),
      );
      const [first, second] = await Promise.all([
        b.take(u, 'quiet'),
        b.take(u, 'quiet'),
      ]);
      expect(first.length + second.length).toBe(50); // nothing lost, nothing duplicated
      expect(await b.size(u, 'quiet')).toBe(0);
    });

    it('the flush time only ever moves EARLIER: a later add cannot push a due digest back', async () => {
      const u = user();
      const b = svc();
      const soon = Date.now() + 1000;
      await b.add(u, 'daily', 'n-1', new Date(soon));
      await b.add(u, 'daily', 'n-2', new Date(soon + 3_600_000)); // a much later flush time
      const score = await client.zscore('notif:digest:due', `${u}|daily`);
      expect(Number(score)).toBe(soon);
      cleanup.push(`notif:digest:${u}:daily`);
      await client.zrem('notif:digest:due', `${u}|daily`);
    });

    it('restore() puts items back and re-schedules the bucket', async () => {
      const u = user();
      const b = svc();
      await b.restore(u, 'hourly', ['a', 'b'], new Date(Date.now() + 300_000));
      expect(await b.size(u, 'hourly')).toBe(2);
      expect(
        await client.zscore('notif:digest:due', `${u}|hourly`),
      ).not.toBeNull();
      await b.take(u, 'hourly');
      await client.zrem('notif:digest:due', `${u}|hourly`);
    });
  });
});
