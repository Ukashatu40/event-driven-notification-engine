// tests/unit/notifications/deduplication.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { DeduplicationService } from '../../../src/notifications/engine/deduplication.service';

/** Minimal in-memory Redis honouring SET … NX and GET/DEL. */
const fakeRedis = () => {
  const store = new Map<string, string>();
  const client = {
    set: jest.fn(
      async (k: string, v: string, _ex: string, _t: number, nx?: string) => {
        if (nx === 'NX' && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      },
    ),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (...ks: string[]) => ks.forEach((k) => store.delete(k))),
  };
  return { store, redis: { getClient: () => client } };
};

describe('DeduplicationService.claim / release', () => {
  it('lets the first request through and holds its keys', async () => {
    const { redis, store } = fakeRedis();
    const svc = new DeduplicationService(redis as never);
    expect(await svc.claim('n-1', 'idem-1', 'MKTX-001', 'u:RELIANCE')).toEqual({
      isDuplicate: false,
    });
    expect(store.size).toBe(2); // idempotency key + fingerprint
  });

  it('returns the ORIGINAL id for a repeat idempotency key', async () => {
    const { redis } = fakeRedis();
    const svc = new DeduplicationService(redis as never);
    await svc.claim('n-1', 'idem-1', 'MKTX-001', 'u:RELIANCE');
    expect(
      await svc.claim('n-2', 'idem-1', 'MKTX-001', 'u:OTHER'),
    ).toMatchObject({
      isDuplicate: true,
      existingNotificationId: 'n-1',
      reason: 'IDEMPOTENCY_KEY_DUPLICATE',
    });
  });

  it('collapses a burst for the same user+entity by fingerprint (B2.4)', async () => {
    const { redis } = fakeRedis();
    const svc = new DeduplicationService(redis as never);
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(
        await svc.claim(`n-${i}`, undefined, 'MKTX-001', 'u1:RELIANCE'),
      );
    expect(results.filter((r) => !r.isDuplicate)).toHaveLength(1);
    expect(results[4]).toMatchObject({
      reason: 'FINGERPRINT_DUPLICATE',
      existingNotificationId: 'n-0',
    });
  });

  it('does NOT dedupe the same symbol across different users', async () => {
    const { redis } = fakeRedis();
    const svc = new DeduplicationService(redis as never);
    await svc.claim('n-1', undefined, 'MKTX-001', 'userA:RELIANCE');
    expect(
      (await svc.claim('n-2', undefined, 'MKTX-001', 'userB:RELIANCE'))
        .isDuplicate,
    ).toBe(false);
  });

  it('is idempotent for the same notification id (Kafka redelivery)', async () => {
    const { redis } = fakeRedis();
    const svc = new DeduplicationService(redis as never);
    await svc.claim('n-1', 'idem-1', 'MKTX-001', 'u:X');
    expect(
      (await svc.claim('n-1', 'idem-1', 'MKTX-001', 'u:X')).isDuplicate,
    ).toBe(false);
  });

  it('keeps nothing when the second key is contested (no half-claims)', async () => {
    const { redis, store } = fakeRedis();
    const svc = new DeduplicationService(redis as never);
    await svc.claim('n-1', undefined, 'MKTX-001', 'u:X'); // holds fingerprint only
    const before = store.size;
    await svc.claim('n-2', 'idem-new', 'MKTX-001', 'u:X'); // idem key free, fingerprint taken
    expect(store.size).toBe(before); // idem-new was rolled back
  });

  it('release frees only claims held by that notification', async () => {
    const { redis, store } = fakeRedis();
    const svc = new DeduplicationService(redis as never);
    await svc.claim('n-1', 'idem-1', 'MKTX-001', 'u:X');
    await svc.release('someone-else', 'idem-1', 'MKTX-001', 'u:X');
    expect(store.size).toBe(2);
    await svc.release('n-1', 'idem-1', 'MKTX-001', 'u:X');
    expect(store.size).toBe(0);
  });
});
