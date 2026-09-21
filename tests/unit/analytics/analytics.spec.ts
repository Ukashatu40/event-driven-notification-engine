// tests/unit/analytics/analytics.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { AnalyticsController } from '../../../src/analytics/analytics.controller';
import { RealtimeCountersService } from '../../../src/analytics/realtime-counters.service';

describe('AnalyticsService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    notification: {
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    deliveryAttempt: { groupBy: jest.fn(), findMany: jest.fn() },
    providerHealth: { findMany: jest.fn() },
    consentRecord: { findMany: jest.fn() },
    user: { count: jest.fn() },
  };
  const counters = { getCount: jest.fn() };
  let svc: AnalyticsService;

  /** Route `notification.count` by the status filter so each metric gets its own number. */
  const countBy = (fn: (where: any) => number) =>
    prisma.notification.count.mockImplementation(async ({ where }: any) =>
      fn(where),
    );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.count.mockResolvedValue(1000);
    prisma.notification.aggregate.mockResolvedValue({
      _sum: { costPaisa: 25_000 },
    });
    prisma.deliveryAttempt.findMany.mockResolvedValue([]);
    svc = new AnalyticsService(prisma, counters as never);
  });

  describe('getDeliveryRates', () => {
    beforeEach(() =>
      countBy((w) => {
        if (w.status === 'CAPPED') return 50;
        if (w.status === 'DND') return 10;
        if (w.status?.in?.includes('DELIVERED'))
          return w.status.in.length === 2 ? 80 : 100;
        if (w.status === 'READ') return 40;
        return 100; // "sent" (attempted)
      }),
    );

    it('has exactly the Appendix A shape', async () => {
      const r = await svc.getDeliveryRates(7);
      expect(Object.keys(r)).toEqual([
        'period',
        'summary',
        'byChannel',
        'byPriority',
        'frequencyCapHits',
        'dndBlocks',
        'costSummary',
      ]);
      expect(Object.keys(r.summary)).toEqual([
        'totalSent',
        'totalDelivered',
        'totalRead',
        'overallDeliveryRate',
        'overallReadRate',
      ]);
      expect(Object.keys(r.byChannel)).toEqual([
        'sms',
        'email',
        'push',
        'whatsapp',
        'in_app',
      ]);
      expect(Object.keys(r.byPriority)).toEqual([
        'CRITICAL',
        'HIGH',
        'MEDIUM',
        'LOW',
      ]);
    });

    it('a 7-day report spans 7 days', async () => {
      const r = await svc.getDeliveryRates(7);
      const days =
        (Date.parse(r.period.end) - Date.parse(r.period.start)) / 86_400_000;
      expect(Math.round(days)).toBe(7);
    });

    it('computes rates as delivered/sent and read/delivered', async () => {
      const r = await svc.getDeliveryRates(7);
      expect(r.summary.overallDeliveryRate).toBeCloseTo(
        r.summary.totalDelivered / r.summary.totalSent,
      );
      expect(r.summary.overallReadRate).toBeCloseTo(
        r.summary.totalRead / r.summary.totalDelivered,
      );
    });

    it('counts only notifications that reached a provider as "sent" (suppressed ones are not)', async () => {
      await svc.getDeliveryRates(7);
      const sentQuery = prisma.notification.count.mock.calls
        .map((c: any[]) => c[0].where)
        .find(
          (w: any) =>
            Array.isArray(w.status?.in) && w.status.in.includes('SENT'),
        );
      expect(sentQuery.status.in).toEqual(
        expect.arrayContaining(['SENT', 'DELIVERED', 'FAILED', 'DLQ']),
      );
      for (const suppressed of [
        'CAPPED',
        'QUIET',
        'DND',
        'CREATED',
        'ROUTED',
      ]) {
        expect(sentQuery.status.in).not.toContain(suppressed);
      }
    });

    it('reports cap hits as a share of users, DND blocks split by class, and cost in paisa and INR', async () => {
      const r = await svc.getDeliveryRates(7);
      expect(r.frequencyCapHits).toEqual({
        total: 50,
        percentageOfUsersHittingCap: 0.05,
      });
      expect(r.dndBlocks.total).toBe(10);
      expect(r.dndBlocks.transactionalBlocked).toBe(0); // must always be zero
      expect(r.costSummary.totalPaisa).toBe(25_000);
      expect(r.costSummary.totalInr).toBe(250);
    });

    it('takes P99 latency per priority from delivery attempts', async () => {
      prisma.deliveryAttempt.findMany.mockResolvedValue(
        Array.from({ length: 100 }, (_, i) => ({ latencyMs: i + 1 })),
      );
      const r = await svc.getDeliveryRates(7);
      expect(r.byPriority['CRITICAL'].p99LatencyMs).toBe(100);
    });

    it('never divides by zero when there is no data', async () => {
      countBy(() => 0);
      prisma.user.count.mockResolvedValue(0);
      const r = await svc.getDeliveryRates(7);
      expect(r.summary.overallDeliveryRate).toBe(0);
      expect(r.frequencyCapHits.percentageOfUsersHittingCap).toBe(0);
      expect(r.costSummary.perNotificationAvgPaisa).toBe(0);
    });
  });

  describe('getChannelPerformance — computed from real data, not approximated', () => {
    it('combines attempts, failures, confirmed deliveries and circuit state per provider', async () => {
      prisma.deliveryAttempt.groupBy
        .mockResolvedValueOnce([
          {
            provider: 'termii',
            _count: { id: 200 },
            _avg: { latencyMs: 120.4, costPaisa: 400 },
          },
        ])
        .mockResolvedValueOnce([{ provider: 'termii', _count: { id: 10 } }]);
      prisma.notification.groupBy.mockResolvedValue([
        { provider: 'termii', _count: { id: 150 } },
      ]);
      prisma.providerHealth.findMany.mockResolvedValue([
        { provider: 'termii', failureCount: 3 },
      ]);

      const [row] = await svc.getChannelPerformance(7);

      expect(row).toEqual({
        channel: 'sms',
        provider: 'termii',
        sent: 200,
        delivered: 150,
        failed: 10,
        deliveryRate: 0.75,
        avgLatencyMs: 120,
        costPaisa: 400,
        circuitBreakerTrips: 3,
      });
    });

    it('does NOT invent numbers: no receipts means zero delivered (the old code returned 96%)', async () => {
      prisma.deliveryAttempt.groupBy
        .mockResolvedValueOnce([
          {
            provider: 'msg91',
            _count: { id: 100 },
            _avg: { latencyMs: 5, costPaisa: 20 },
          },
        ])
        .mockResolvedValueOnce([]);
      prisma.notification.groupBy.mockResolvedValue([]);
      prisma.providerHealth.findMany.mockResolvedValue([]);
      const [row] = await svc.getChannelPerformance(7);
      expect(row).toMatchObject({
        delivered: 0,
        failed: 0,
        deliveryRate: 0,
        circuitBreakerTrips: 0,
      });
    });

    it('maps every provider to its channel, including Termii, and flags unknown ones', async () => {
      const providers = [
        'msg91',
        'termii',
        'twilio',
        'nodemailer',
        'fcm',
        'whatsapp_cloud',
        'in_app',
        'mystery',
      ];
      prisma.deliveryAttempt.groupBy
        .mockResolvedValueOnce(
          providers.map((provider) => ({
            provider,
            _count: { id: 1 },
            _avg: {},
          })),
        )
        .mockResolvedValueOnce([]);
      prisma.notification.groupBy.mockResolvedValue([]);
      prisma.providerHealth.findMany.mockResolvedValue([]);
      const rows = await svc.getChannelPerformance(7);
      expect(rows.map((r) => r.channel)).toEqual([
        'sms',
        'sms',
        'sms',
        'email',
        'push',
        'whatsapp',
        'in_app',
        'unknown',
      ]);
    });
  });

  describe('getOptOutTrends', () => {
    it('groups consent records by day into opt-ins and opt-outs', async () => {
      prisma.consentRecord.findMany.mockResolvedValue([
        { granted: true, grantedAt: new Date('2026-09-01T10:00:00Z') },
        { granted: false, grantedAt: new Date('2026-09-01T11:00:00Z') },
        { granted: false, grantedAt: new Date('2026-09-02T09:00:00Z') },
      ]);
      expect(await svc.getOptOutTrends(30)).toEqual([
        { date: '2026-09-01', optOuts: 1, optIns: 1 },
        { date: '2026-09-02', optOuts: 1, optIns: 0 },
      ]);
    });
  });

  describe('getRealtimeStats', () => {
    it('reads the sliding-window counters and derives the delivery rate', async () => {
      counters.getCount.mockImplementation(
        async (metric: string, labels: Record<string, string>) =>
          metric === 'deliveries'
            ? labels['status'] === 'delivered'
              ? 90
              : 10
            : 5,
      );
      const r = await svc.getRealtimeStats();
      expect(r).toMatchObject({
        deliveredLastHour: 90,
        failedLastHour: 10,
        cappedLastHour: 5,
        dndBlockedLastHour: 5,
        deliveryRateLastHour: 0.9,
      });
    });

    it('reports a 0 rate (not NaN) when nothing happened', async () => {
      counters.getCount.mockResolvedValue(0);
      expect((await svc.getRealtimeStats()).deliveryRateLastHour).toBe(0);
    });
  });
});

describe('AnalyticsController.parsePeriod', () => {
  const svc = {
    getDeliveryRates: jest.fn().mockResolvedValue({}),
    getChannelPerformance: jest.fn().mockResolvedValue([]),
    getOptOutTrends: jest.fn().mockResolvedValue([]),
    getRealtimeStats: jest.fn().mockResolvedValue({}),
  };
  const c = new AnalyticsController(svc as never);
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['7d', 7],
    ['30', 30],
    ['1d', 1],
    ['abc', 7],
    ['0d', 1],
    ['365d', 90],
  ])('%s → %i days (clamped 1–90, default 7)', async (input, days) => {
    await c.getDeliveryRates(input);
    expect(svc.getDeliveryRates).toHaveBeenCalledWith(days);
  });

  it('delegates the other endpoints', async () => {
    await c.getChannelPerformance('14d');
    await c.getOptOutTrends('30d');
    await c.getRealtimeStats();
    expect(svc.getChannelPerformance).toHaveBeenCalledWith(14);
    expect(svc.getOptOutTrends).toHaveBeenCalledWith(30);
    expect(svc.getRealtimeStats).toHaveBeenCalled();
  });
});

describe('RealtimeCountersService', () => {
  const client = { zremrangebyscore: jest.fn(), expire: jest.fn() };
  const redis = { zadd: jest.fn(), zcount: jest.fn(), getClient: () => client };
  const svc = new RealtimeCountersService(redis as never);
  beforeEach(() => jest.clearAllMocks());

  it('records an event in a sliding-window sorted set, trims old entries and sets a TTL', async () => {
    await svc.increment(
      'deliveries',
      { status: 'delivered', channel: 'sms' },
      600,
    );
    expect(redis.zadd).toHaveBeenCalledWith(
      'analytics:deliveries:channel=sms,status=delivered',
      expect.any(Number),
      expect.any(String),
    );
    expect(client.zremrangebyscore).toHaveBeenCalled();
    expect(client.expire).toHaveBeenCalledWith(
      'analytics:deliveries:channel=sms,status=delivered',
      660,
    );
  });

  it('builds the same key regardless of label order', async () => {
    await svc.getCount('m', { b: '2', a: '1' });
    await svc.getCount('m', { a: '1', b: '2' });
    expect(redis.zcount.mock.calls[0][0]).toBe(redis.zcount.mock.calls[1][0]);
  });

  it('counts only events inside the window, and converts to a per-hour rate', async () => {
    redis.zcount.mockResolvedValue(30);
    expect(await svc.getCount('m', {}, 1800)).toBe(30);
    expect(await svc.getRate('m', {}, 1800)).toBe(60); // 30 in half an hour = 60/h
  });
});
