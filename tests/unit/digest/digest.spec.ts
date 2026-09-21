// tests/unit/digest/digest.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import {
  DigestBucketService,
  DIGEST_MIN_ITEMS,
} from '../../../src/notifications/digest/digest-bucket.service';
import { DigestFlushService } from '../../../src/notifications/digest/digest-flush.service';
import { RoutingEngineService } from '../../../src/notifications/routing/routing-engine.service';
import { REDIS_KEYS } from '../../../src/shared/constants/redis-keys';

describe('DigestBucketService', () => {
  const exec = jest.fn();
  const chain: any = {
    zadd: jest.fn(() => chain),
    zrange: jest.fn(() => chain),
    del: jest.fn(() => chain),
    exec,
  };
  const client = { multi: jest.fn(() => chain), zrem: jest.fn() };
  const redis = {
    getClient: () => client,
    zrangebyscore: jest.fn(),
    zcount: jest.fn(),
  };
  const svc = new DigestBucketService(redis as never);
  beforeEach(() => {
    jest.clearAllMocks();
    chain.zadd.mockReturnValue(chain);
    chain.zrange.mockReturnValue(chain);
    chain.del.mockReturnValue(chain);
  });

  it('adds the item and schedules the flush in one MULTI, moving the due time only EARLIER (LT)', async () => {
    const due = new Date('2026-09-22T07:00:00Z');
    await svc.add('u-1', 'daily', 'n-1', due);
    expect(chain.zadd).toHaveBeenNthCalledWith(
      1,
      REDIS_KEYS.digestBucket('u-1', 'daily'),
      expect.any(Number),
      'n-1',
    );
    expect(chain.zadd).toHaveBeenNthCalledWith(
      2,
      REDIS_KEYS.digestDue,
      'LT',
      'CH',
      due.getTime(),
      'u-1|daily',
    );
    expect(exec).toHaveBeenCalled();
  });

  it('claims each due bucket exactly once across replicas (ZREM returns 0 for the loser)', async () => {
    redis.zrangebyscore.mockResolvedValue(['u-1|daily', 'u-2|capped']);
    client.zrem.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await svc.claimDue(123)).toEqual([
      { userId: 'u-1', source: 'daily' },
    ]);
    expect(redis.zrangebyscore).toHaveBeenCalledWith(
      REDIS_KEYS.digestDue,
      0,
      123,
      100,
    );
  });

  it('take() reads and empties the bucket atomically', async () => {
    exec.mockResolvedValue([
      [null, ['n-1', 'n-2']],
      [null, 1],
    ]);
    expect(await svc.take('u-1', 'quiet')).toEqual(['n-1', 'n-2']);
    expect(chain.zrange).toHaveBeenCalledWith(
      REDIS_KEYS.digestBucket('u-1', 'quiet'),
      0,
      -1,
    );
    expect(chain.del).toHaveBeenCalledWith(
      REDIS_KEYS.digestBucket('u-1', 'quiet'),
    );
  });

  it('take() of a missing bucket is an empty list, not an error', async () => {
    exec.mockResolvedValue(null);
    expect(await svc.take('u', 'daily')).toEqual([]);
  });

  it('restore() puts every item back with the new due time', async () => {
    await svc.restore('u-1', 'hourly', ['a', 'b'], new Date(1000));
    expect(chain.zadd).toHaveBeenCalledTimes(4); // 2 items × (bucket + due)
  });

  it('nextHour() is the next full UTC hour', () => {
    expect(
      DigestBucketService.nextHour(
        new Date('2026-09-21T10:42:11Z'),
      ).toISOString(),
    ).toBe('2026-09-21T11:00:00.000Z');
    expect(
      DigestBucketService.nextHour(
        new Date('2026-09-21T23:59:59Z'),
      ).toISOString(),
    ).toBe('2026-09-22T00:00:00.000Z');
  });

  it('thresholds: user-chosen digests need 1 item, capped needs 3', () => {
    expect(DIGEST_MIN_ITEMS).toEqual({
      hourly: 1,
      daily: 1,
      quiet: 1,
      capped: 3,
    });
  });
});

describe('RoutingEngineService — digest decision', () => {
  const resolver = { resolve: jest.fn() };
  const caps = { check: jest.fn() };
  const quiet = { check: jest.fn() };
  const routing = new RoutingEngineService(
    resolver as never,
    caps as never,
    quiet as never,
    { recordCapHit: jest.fn() } as never,
  );
  const user = { userId: 'u', accountType: 'BASIC', timezone: 'Africa/Lagos' };
  const resolved = (digestMode: string, channels = ['push', 'in_app']) =>
    resolver.resolve.mockResolvedValue({
      channels,
      digestMode,
      regulatoryOverride: false,
      quietHoursOverride: false,
    });
  beforeEach(() => {
    jest.resetAllMocks();
    caps.check.mockResolvedValue({ capped: false });
    quiet.check.mockResolvedValue({ suppressed: false });
  });

  it.each(['HOURLY', 'DAILY'])(
    'a %s digest preference holds a normal event for the digest, without spending caps or quiet-hours checks',
    async (mode) => {
      resolved(mode);
      const d = await routing.route('MKTX-004', user, 3);
      expect(d.digest).toEqual({ mode });
      expect(d.channels).toEqual([]);
      expect(caps.check).not.toHaveBeenCalled();
      expect(quiet.check).not.toHaveBeenCalled();
    },
  );

  it('IMMEDIATE means no digest', async () => {
    resolved('IMMEDIATE');
    expect((await routing.route('MKTX-004', user, 3)).digest).toBeUndefined();
  });

  it.each(['RISK-001', 'RISK-002', 'RISK-003', 'MKTX-002'])(
    'CRITICAL %s is NEVER digested, whatever the user chose',
    async (e) => {
      resolved('DAILY', ['sms', 'push']);
      const d = await routing.route(e as never, user, 1);
      expect(d.digest).toBeUndefined();
      expect(d.channels.length).toBeGreaterThan(0);
    },
  );

  it.each([
    'TXNX-001',
    'TXNX-002',
    'TXNX-003',
    'TXNX-005',
    'SIPX-002',
    'SIPX-003',
    'REGX-001',
    'REGX-003',
  ])('regulator-mandated %s is NEVER digested', async (e) => {
    resolved('DAILY', ['sms', 'push']);
    expect((await routing.route(e as never, user, 2)).digest).toBeUndefined();
  });

  it('does not digest when there is nothing to deliver anyway', async () => {
    resolved('DAILY', []);
    expect((await routing.route('MKTX-004', user, 3)).digest).toBeUndefined();
  });
});

describe('DigestFlushService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    user: { findUnique: jest.fn() },
    notification: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    notificationStateLog: { create: jest.fn() },
  };
  const buckets = { take: jest.fn(), restore: jest.fn(), claimDue: jest.fn() };
  const engine = { resume: jest.fn() };
  const templates = { supportsChannel: jest.fn(), render: jest.fn() };
  const quiet = { checkWindow: jest.fn() };
  const prom = {
    digestsSentTotal: { inc: jest.fn() },
    digestItemsTotal: { inc: jest.fn() },
  };
  const config = { get: jest.fn() };
  let svc: DigestFlushService;

  const USER = {
    id: 'u-1',
    name: 'Ada',
    language: 'YO',
    timezone: 'Africa/Lagos',
    market: 'NG',
  };
  const item = (id: string, over = {}) => ({
    id,
    eventType: 'MKTX-004',
    templateId: 'MKTX-004-v1',
    personalisationData: { symbol: 'X' },
    classification: 'PROMOTIONAL',
    status: 'DIGEST_PENDING',
    ...over,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue(USER);
    buckets.take.mockResolvedValue(['a', 'b']);
    quiet.checkWindow.mockResolvedValue({ suppressed: false });
    prisma.notification.findMany.mockResolvedValue([item('a'), item('b')]);
    prisma.notification.findUnique.mockResolvedValue({ status: 'QUEUED' });
    templates.supportsChannel.mockReturnValue(true);
    templates.render.mockImplementation(async (_t: string, ch: string) => ({
      channel: ch,
      title: 'New 52-week high',
      body: 'INFY hit ₦1,000',
    }));
    svc = new DigestFlushService(
      prisma,
      buckets as never,
      engine as never,
      templates as never,
      quiet as never,
      prom as never,
      config as never,
    );
  });

  it('builds ONE digest notification, sends it on push + in-app, and marks every folded item DIGESTED', async () => {
    expect(await svc.flush('u-1', 'daily')).toBe('sent');

    const created = prisma.notification.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      eventType: 'DIGEST',
      templateId: 'DIGEST-v1',
      userId: 'u-1',
      priority: 5,
      status: 'ROUTED',
      classification: 'PROMOTIONAL',
    });
    expect(created.personalisationData).toMatchObject({
      count: 2,
      more: 0,
      source: 'daily',
    });
    expect(created.personalisationData.items).toEqual([
      { text: 'New 52-week high: INFY hit ₦1,000' },
      { text: 'New 52-week high: INFY hit ₦1,000' },
    ]);
    expect(created.metadata).toEqual({ digestOf: ['a', 'b'], source: 'daily' });
    expect(engine.resume).toHaveBeenCalledWith(created.id, ['push', 'in_app']);

    const digested = prisma.notificationStateLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .filter((d: any) => d.toStatus === 'DIGESTED');
    expect(digested.map((d: any) => d.notificationId)).toEqual(['a', 'b']);
    expect(digested[0]).toMatchObject({
      fromStatus: 'DIGEST_PENDING',
      actor: 'digest_aggregator',
      metadata: { digestNotificationId: created.id, source: 'daily' },
    });
    expect(prom.digestsSentTotal.inc).toHaveBeenCalledWith({ source: 'daily' });
    expect(prom.digestItemsTotal.inc).toHaveBeenCalledWith(
      { source: 'daily' },
      2,
    );
  });

  it("renders each line in the USER's language and market currency", async () => {
    await svc.flush('u-1', 'daily');
    expect(templates.render).toHaveBeenCalledWith(
      'MKTX-004-v1',
      'push',
      expect.objectContaining({
        language: 'yo',
        currency: 'NGN',
        userId: 'u-1',
      }),
    );
  });

  it('shows at most 5 lines and says how many more there were', async () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`n-${i}`));
    buckets.take.mockResolvedValue(many.map((m) => m.id));
    prisma.notification.findMany.mockResolvedValue(many);
    await svc.flush('u-1', 'daily');
    const data =
      prisma.notification.create.mock.calls[0][0].data.personalisationData;
    expect(data.count).toBe(9);
    expect(data.items).toHaveLength(5);
    expect(data.more).toBe(4);
  });

  it('a digest containing ANY promotional item is promotional; all-transactional stays transactional', async () => {
    prisma.notification.findMany.mockResolvedValue([
      item('a', { classification: 'TRANSACTIONAL' }),
      item('b', { classification: 'TRANSACTIONAL' }),
    ]);
    await svc.flush('u-1', 'daily');
    expect(
      prisma.notification.create.mock.calls[0][0].data.classification,
    ).toBe('TRANSACTIONAL');
  });

  it('clips very long lines to 100 characters', async () => {
    templates.render.mockResolvedValue({ title: 'T', body: 'x'.repeat(500) });
    await svc.flush('u-1', 'daily');
    const text =
      prisma.notification.create.mock.calls[0][0].data.personalisationData
        .items[0].text;
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith('…')).toBe(true);
  });

  it('falls back to the event type when an item cannot be rendered — one bad item never blocks the digest', async () => {
    templates.render.mockRejectedValue(new Error('template exploded'));
    expect(await svc.flush('u-1', 'daily')).toBe('sent');
    expect(
      prisma.notification.create.mock.calls[0][0].data.personalisationData
        .items[0].text,
    ).toBe('MKTX-004');
  });

  describe('thresholds', () => {
    it('CAPPED needs 3: two capped notifications are left alone (no digest, they stay CAPPED)', async () => {
      prisma.notification.findMany.mockResolvedValue([
        item('a', { status: 'CAPPED' }),
        item('b', { status: 'CAPPED' }),
      ]);
      expect(await svc.flush('u-1', 'capped')).toBe('below-threshold');
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(prisma.notification.update).not.toHaveBeenCalled();
    });

    it('three capped notifications become a digest, each moved CAPPED → DIGEST_PENDING → DIGESTED', async () => {
      const three = ['a', 'b', 'c'].map((id) => item(id, { status: 'CAPPED' }));
      buckets.take.mockResolvedValue(['a', 'b', 'c']);
      prisma.notification.findMany.mockResolvedValue(three);
      expect(await svc.flush('u-1', 'capped')).toBe('sent');
      const transitions = prisma.notificationStateLog.create.mock.calls.map(
        (c: any[]) => `${c[0].data.fromStatus}>${c[0].data.toStatus}`,
      );
      expect(
        transitions.filter((t: string) => t === 'CAPPED>DIGEST_PENDING'),
      ).toHaveLength(3);
      expect(
        transitions.filter((t: string) => t === 'DIGEST_PENDING>DIGESTED'),
      ).toHaveLength(3);
    });

    it('a user-chosen digest of just one item is still sent', async () => {
      buckets.take.mockResolvedValue(['a']);
      prisma.notification.findMany.mockResolvedValue([item('a')]);
      expect(await svc.flush('u-1', 'hourly')).toBe('sent');
    });
  });

  describe('quiet hours', () => {
    it('an hourly/daily digest that comes due while the user is asleep is DEFERRED to the window end, with nothing lost', async () => {
      quiet.checkWindow.mockResolvedValue({
        suppressed: true,
        deliverAt: '2026-09-22T07:00:00.000Z',
      });
      expect(await svc.flush('u-1', 'hourly')).toBe('deferred');
      expect(buckets.restore).toHaveBeenCalledWith(
        'u-1',
        'hourly',
        ['a', 'b'],
        new Date('2026-09-22T07:00:00.000Z'),
      );
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('the overnight "quiet" digest is not re-deferred: it is exactly what runs when quiet hours end', async () => {
      await svc.flush('u-1', 'quiet');
      expect(quiet.checkWindow).not.toHaveBeenCalled();
    });
  });

  describe('nothing is lost', () => {
    it('if building the digest throws, every item goes back into its bucket for a retry in 5 minutes', async () => {
      engine.resume.mockRejectedValue(new Error('rabbit down'));
      const before = Date.now();
      await expect(svc.flush('u-1', 'daily')).rejects.toThrow('rabbit down');
      const [, , ids, due] = buckets.restore.mock.calls[0];
      expect(ids).toEqual(['a', 'b']);
      expect(due.getTime() - before).toBeGreaterThanOrEqual(5 * 60_000 - 50);
      // and the items were NOT marked DIGESTED
      expect(
        prisma.notificationStateLog.create.mock.calls.some(
          (c: any[]) => c[0].data.toStatus === 'DIGESTED',
        ),
      ).toBe(false);
    });

    it('if the digest itself ends up in the DLQ, the held notifications are restored, not marked DIGESTED', async () => {
      prisma.notification.findUnique.mockResolvedValue({ status: 'DLQ' });
      await expect(svc.flush('u-1', 'daily')).rejects.toThrow(
        /could not be queued/,
      );
      expect(buckets.restore).toHaveBeenCalled();
      expect(
        prisma.notificationStateLog.create.mock.calls.some(
          (c: any[]) => c[0].data.toStatus === 'DIGESTED',
        ),
      ).toBe(false);
    });

    it('ignores ids whose notification has already moved on (e.g. delivered another way)', async () => {
      prisma.notification.findMany.mockResolvedValue([]);
      expect(await svc.flush('u-1', 'daily')).toBe('empty');
      const where = prisma.notification.findMany.mock.calls[0][0].where;
      expect(where.status.in).toEqual(['DIGEST_PENDING', 'CAPPED']);
    });

    it('an empty bucket is a no-op; a deleted user just drops the bucket', async () => {
      buckets.take.mockResolvedValue([]);
      expect(await svc.flush('u-1', 'daily')).toBe('empty');
      prisma.user.findUnique.mockResolvedValue(null);
      expect(await svc.flush('gone', 'daily')).toBe('no-user');
    });
  });

  describe('flushDue', () => {
    it('flushes every claimed bucket, counts the digests sent, and survives one failing', async () => {
      buckets.claimDue.mockResolvedValue([
        { userId: 'u-1', source: 'daily' },
        { userId: 'u-2', source: 'hourly' },
        { userId: 'u-3', source: 'daily' },
      ]);
      prisma.user.findUnique
        .mockResolvedValueOnce(USER)
        .mockRejectedValueOnce(new Error('db'))
        .mockResolvedValueOnce(USER);
      expect(await svc.flushDue(1234)).toBe(2);
      expect(buckets.claimDue).toHaveBeenCalledWith(1234);
    });
  });

  it('the worker is off when DIGEST_ENABLED=false', () => {
    config.get.mockReturnValue('false');
    const s = new DigestFlushService(
      prisma,
      buckets as never,
      engine as never,
      templates as never,
      quiet as never,
      prom as never,
      config as never,
    );
    s.onModuleInit();
    expect((s as any).handle).toBeNull();
  });
});
