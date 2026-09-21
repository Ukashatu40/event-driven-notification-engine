// tests/unit/api/throttler-storage.spec.ts
import { RedisSlidingWindowThrottlerStorage } from '../../../src/api/throttler/redis-sliding-window.storage';

/** Sorted-set fake honouring the ZREMRANGEBYSCORE / ZADD / ZCARD / ZRANGE sequence. */
const fakeRedis = () => {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  const multi = () => {
    const ops: Array<() => unknown> = [];
    let key = '';
    const chain = {
      zremrangebyscore: (k: string, _min: number, max: number) => {
        key = k;
        ops.push(() => {
          sets.set(
            k,
            (sets.get(k) ?? []).filter((e) => e.score > max),
          );
          return 0;
        });
        return chain;
      },
      zadd: (k: string, score: number, member: string) => {
        ops.push(
          () => (sets.set(k, [...(sets.get(k) ?? []), { score, member }]), 1),
        );
        return chain;
      },
      zcard: (k: string) => (ops.push(() => (sets.get(k) ?? []).length), chain),
      zrange: (k: string) => {
        ops.push(() => {
          const first = [...(sets.get(k) ?? [])].sort(
            (a, b) => a.score - b.score,
          )[0];
          return first ? [first.member, String(first.score)] : [];
        });
        return chain;
      },
      pexpire: () => (ops.push(() => 1), chain),
      exec: async () => ops.map((f) => [null, f()]),
    };
    void key;
    return chain;
  };
  return { sets, redis: { getClient: () => ({ multi }) } };
};

describe('RedisSlidingWindowThrottlerStorage', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('counts requests inside the window', async () => {
    const { redis } = fakeRedis();
    const s = new RedisSlidingWindowThrottlerStorage(redis as never);
    expect((await s.increment('ip:1', 60_000)).totalHits).toBe(1);
    expect((await s.increment('ip:1', 60_000)).totalHits).toBe(2);
    expect((await s.increment('ip:1', 60_000)).totalHits).toBe(3);
  });

  it('keeps separate counters per key', async () => {
    const { redis } = fakeRedis();
    const s = new RedisSlidingWindowThrottlerStorage(redis as never);
    await s.increment('ip:A', 60_000);
    await s.increment('ip:A', 60_000);
    expect((await s.increment('ip:B', 60_000)).totalHits).toBe(1);
  });

  it('SLIDES: requests age out one by one, not all at a fixed boundary', async () => {
    const { redis } = fakeRedis();
    const s = new RedisSlidingWindowThrottlerStorage(redis as never);

    await s.increment('k', 60_000); // t=0
    jest.advanceTimersByTime(40_000);
    await s.increment('k', 60_000); // t=40s
    jest.advanceTimersByTime(30_000); // t=70s → the t=0 request has left the window

    expect((await s.increment('k', 60_000)).totalHits).toBe(2); // t=40s + now
  });

  it('a burst straddling a fixed-window boundary is still counted in full', async () => {
    const { redis } = fakeRedis();
    const s = new RedisSlidingWindowThrottlerStorage(redis as never);
    jest.advanceTimersByTime(59_000); // just before a would-be minute boundary
    for (let i = 0; i < 50; i++) await s.increment('k', 60_000);
    jest.advanceTimersByTime(2_000); // just after it
    let last = 0;
    for (let i = 0; i < 50; i++)
      last = (await s.increment('k', 60_000)).totalHits;
    expect(last).toBe(100); // a fixed window would have reset to 50
  });

  it('reports how long until a slot frees up', async () => {
    const { redis } = fakeRedis();
    const s = new RedisSlidingWindowThrottlerStorage(redis as never);
    await s.increment('k', 60_000);
    jest.advanceTimersByTime(20_000);
    expect((await s.increment('k', 60_000)).timeToExpire).toBe(40);
  });

  it('fails OPEN when Redis is down (availability over strictness)', async () => {
    const broken = {
      getClient: () => ({
        multi: () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    };
    const s = new RedisSlidingWindowThrottlerStorage(broken as never);
    expect((await s.increment('k', 60_000)).totalHits).toBe(1);
  });
});
