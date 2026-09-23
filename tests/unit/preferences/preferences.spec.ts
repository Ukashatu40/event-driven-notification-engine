// tests/unit/preferences/preferences.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { NotFoundException } from '@nestjs/common';
import { PreferenceResolverService } from '../../../src/preferences/preference-resolver.service';
import { PreferenceCacheService } from '../../../src/preferences/preference-cache.service';
import { PreferencesService } from '../../../src/preferences/preferences.service';

describe('PreferenceResolverService — the 4-layer hierarchy (spec A5.1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { userPreference: { findMany: jest.fn() } };
  const cache = { get: jest.fn(), set: jest.fn() };
  let resolver: PreferenceResolverService;

  /** Cached prefs in the shape the resolver reads. */
  const cached = (
    byCategory: Record<
      string,
      { channels: Record<string, boolean>; digestMode?: string }
    >,
  ) =>
    cache.get.mockResolvedValue({
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [
          k,
          { digestMode: 'IMMEDIATE', ...v },
        ]),
      ),
    });

  beforeEach(() => {
    jest.resetAllMocks();
    resolver = new PreferenceResolverService(prisma, cache as never);
  });

  describe('Layer 1 — system defaults', () => {
    it.each([
      ['RISK-004', ['sms', 'push', 'in_app']],
      ['SIPX-001', ['push', 'email']],
      ['MKTX-004', ['push', 'in_app']],
      ['TXNX-004', ['sms', 'push', 'email']],
    ])('%s with no user preferences → %j', async (event, expected) => {
      cache.get.mockResolvedValue({ byCategory: {} });
      const r = await resolver.resolve('u', event as never, 'BASIC');
      expect(r.channels.sort()).toEqual([...expected].sort());
    });
  });

  describe('Layer 2 — segment overrides', () => {
    it('PREMIUM and HNI get WhatsApp added; BASIC does not', async () => {
      cache.get.mockResolvedValue({ byCategory: {} });
      expect(
        (await resolver.resolve('u', 'SIPX-001', 'PREMIUM')).channels,
      ).toContain('whatsapp');
      expect(
        (await resolver.resolve('u', 'SIPX-001', 'HNI')).channels,
      ).toContain('whatsapp');
      expect(
        (await resolver.resolve('u', 'SIPX-001', 'BASIC')).channels,
      ).not.toContain('whatsapp');
    });
  });

  describe('Layer 3 — explicit user preferences', () => {
    it('a user can switch a default channel off', async () => {
      cached({ MKTX: { channels: { push: false, in_app: true } } });
      const r = await resolver.resolve('u', 'MKTX-004', 'BASIC');
      expect(r.channels).toEqual(['in_app']);
    });

    it('a user can switch on a channel that is not a default', async () => {
      cached({ SIPX: { channels: { sms: true, email: false, push: true } } });
      const r = await resolver.resolve('u', 'SIPX-004', 'BASIC');
      expect(r.channels.sort()).toEqual(['push', 'sms']);
    });

    it('an event-type-specific preference beats the category preference', async () => {
      cached({
        MKTX: { channels: { push: true } },
        'MKTX-004': { channels: { push: false, email: true } },
      });
      const r = await resolver.resolve('u', 'MKTX-004', 'BASIC');
      // push off + email on come from the event-type row; in_app was not
      // mentioned there, so it keeps its default.
      expect(r.channels.sort()).toEqual(['email', 'in_app']);
    });

    it('a channel the user never mentioned falls back to the default for that channel', async () => {
      cached({ MKTX: { channels: { push: false } } }); // in_app not mentioned; it IS a default
      expect(
        (await resolver.resolve('u', 'MKTX-004', 'BASIC')).channels,
      ).toContain('in_app');
    });
  });

  describe('Layer 4 — regulatory override (cannot be disabled)', () => {
    it('a margin call still goes out on SMS + push even if the user turned EVERYTHING off', async () => {
      cached({
        RISK: {
          channels: {
            sms: false,
            push: false,
            email: false,
            whatsapp: false,
            in_app: false,
          },
        },
      });
      const r = await resolver.resolve('u', 'RISK-001', 'BASIC');
      expect(r.channels.sort()).toEqual(['push', 'sms']);
      expect(r.regulatoryOverride).toBe(true);
    });

    it('regulatory channels are ADDED to what the user kept, never replacing it', async () => {
      cached({ RISK: { channels: { sms: false, push: false, in_app: true } } });
      const r = await resolver.resolve('u', 'RISK-001', 'BASIC');
      expect(r.channels.sort()).toEqual(['in_app', 'push', 'sms']);
    });

    it('a non-mandated event has no regulatory override', async () => {
      cached({ MKTX: { channels: { push: false, in_app: false } } });
      const r = await resolver.resolve('u', 'MKTX-004', 'BASIC');
      expect(r.regulatoryOverride).toBe(false);
      expect(r.channels).toEqual([]);
    });

    it('mandated events may bypass quiet hours; others may not', async () => {
      cache.get.mockResolvedValue({ byCategory: {} });
      expect(
        (await resolver.resolve('u', 'RISK-001', 'BASIC')).quietHoursOverride,
      ).toBe(true);
      expect(
        (await resolver.resolve('u', 'MKTX-004', 'BASIC')).quietHoursOverride,
      ).toBe(false);
    });

    it('funds deposited is mandated on SMS + push (payment webhooks depend on it)', async () => {
      cached({ TXNX: { channels: { sms: false, push: false } } });
      const r = await resolver.resolve('u', 'TXNX-005', 'BASIC');
      expect(r.channels).toEqual(expect.arrayContaining(['sms', 'push']));
    });
  });

  describe('caching and determinism', () => {
    it('on a cache miss it loads from the database, groups by event type/category, and caches', async () => {
      cache.get
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ byCategory: { MKTX: { digestMode: 'DAILY' } } });
      prisma.userPreference.findMany.mockResolvedValue([
        {
          eventType: null,
          eventCategory: 'MKTX',
          channel: 'push',
          enabled: false,
          digestMode: 'DAILY',
        },
        {
          eventType: null,
          eventCategory: 'MKTX',
          channel: 'in_app',
          enabled: true,
          digestMode: 'DAILY',
        },
      ]);

      const r = await resolver.resolve('u', 'MKTX-004', 'BASIC');

      expect(prisma.userPreference.findMany).toHaveBeenCalledWith({
        where: { userId: 'u' },
      });
      expect(cache.set).toHaveBeenCalledWith(
        'u',
        expect.objectContaining({ byCategory: expect.any(Object) }),
      );
      expect(r.channels).toEqual(['in_app']);
      expect(r.digestMode).toBe('DAILY');
    });

    it('a cache hit never touches the database', async () => {
      cached({ MKTX: { channels: { push: true } } });
      await resolver.resolve('u', 'MKTX-004', 'BASIC');
      expect(prisma.userPreference.findMany).not.toHaveBeenCalled();
    });

    it('same inputs always produce the same routing (deterministic — Slack lesson C6)', async () => {
      cached({ SIPX: { channels: { sms: true } } });
      const runs = await Promise.all(
        [1, 2, 3, 4, 5].map(() => resolver.resolve('u', 'SIPX-001', 'PREMIUM')),
      );
      for (const r of runs) expect(r).toEqual(runs[0]);
    });

    it('defaults the digest mode to IMMEDIATE', async () => {
      cache.get.mockResolvedValue({ byCategory: {} });
      expect(
        (await resolver.resolve('u', 'MKTX-004', 'BASIC')).digestMode,
      ).toBe('IMMEDIATE');
    });
  });
});

describe('PreferenceCacheService', () => {
  const redis = { getJson: jest.fn(), setJson: jest.fn(), del: jest.fn() };
  const svc = new PreferenceCacheService(redis as never);

  it('reads, writes with a TTL, and invalidates by user key', async () => {
    redis.getJson.mockResolvedValue({ a: 1 });
    expect(await svc.get('u')).toEqual({ a: 1 });
    await svc.set('u', { a: 2 });
    expect(redis.setJson).toHaveBeenCalledWith(
      expect.stringContaining('u'),
      { a: 2 },
      expect.any(Number),
    );
    await svc.invalidate('u');
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('u'));
  });
});

describe('PreferencesService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    userPreference: { findMany: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const cache = { invalidate: jest.fn() };
  let svc: PreferencesService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockResolvedValue([]);
    svc = new PreferencesService(prisma, cache as never);
  });

  describe('getPreferences', () => {
    it('404s an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.getPreferences('u')).rejects.toThrow(NotFoundException);
    });

    it('groups rows by category, lower-cases language and digest mode, lists regulatory overrides', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u',
        language: 'YO',
        timezone: 'Africa/Lagos',
        quietHoursStart: '22:00',
        quietHoursEnd: '07:30',
      });
      prisma.userPreference.findMany.mockResolvedValue([
        {
          eventCategory: 'MKTX',
          channel: 'sms',
          enabled: false,
          digestMode: 'DAILY',
        },
        {
          eventCategory: 'MKTX',
          channel: 'push',
          enabled: true,
          digestMode: 'DAILY',
        },
        {
          eventCategory: 'TXNX',
          channel: 'sms',
          enabled: true,
          digestMode: 'IMMEDIATE',
        },
      ]);

      const r = (await svc.getPreferences('u')) as Record<string, any>;

      expect(r.globalPreferences).toMatchObject({
        language: 'yo',
        digestMode: 'none',
        quietHours: { start: '22:00', end: '07:30', timezone: 'Africa/Lagos' },
      });
      expect(r.categoryPreferences).toEqual([
        {
          category: 'MKTX',
          channels: { sms: false, push: true },
          digestMode: 'daily',
        },
        { category: 'TXNX', channels: { sms: true }, digestMode: 'immediate' },
      ]);
      expect(
        r.regulatoryOverrides.every((o: any) => o.cannotDisable === true),
      ).toBe(true);
      expect(
        r.regulatoryOverrides.find((o: any) => o.eventType === 'RISK-001')
          .channels,
      ).toEqual(['sms', 'push']);
    });
  });

  describe('updatePreferences', () => {
    const dto = (over = {}) =>
      ({
        category: 'MKTX',
        channels: { sms: false, push: true },
        ...over,
      }) as never;

    it('404s an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.updatePreferences('u', dto())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('upserts every channel (unmentioned ones default to enabled) in ONE transaction', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u' });
      await svc.updatePreferences('u', dto());
      expect(prisma.userPreference.upsert).toHaveBeenCalledTimes(5);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const byChannel = Object.fromEntries(
        prisma.userPreference.upsert.mock.calls.map((c: any[]) => [
          c[0].create.channel,
          c[0].create.enabled,
        ]),
      );
      expect(byChannel).toEqual({
        sms: false,
        email: true,
        push: true,
        whatsapp: true,
        in_app: true,
      });
    });

    it('invalidates the cache immediately and reports it', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u' });
      const r = (await svc.updatePreferences('u', dto())) as Record<
        string,
        unknown
      >;
      expect(cache.invalidate).toHaveBeenCalledWith('u');
      expect(r).toMatchObject({
        status: 'updated',
        category: 'MKTX',
        cacheInvalidated: true,
      });
    });

    it('updates quiet hours only when supplied', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u' });
      await svc.updatePreferences('u', dto());
      expect(prisma.user.update).not.toHaveBeenCalled();
      await svc.updatePreferences(
        'u',
        dto({ quietHoursStart: '22:00', quietHoursEnd: '07:00' }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u' },
        data: { quietHoursStart: '22:00', quietHoursEnd: '07:00' },
      });
    });

    describe('quiet hours must span at least 6 hours (spec A6.3)', () => {
      const put = (
        start?: string,
        end?: string,
        stored = { quietHoursStart: '21:00', quietHoursEnd: '08:00' },
      ) => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u', ...stored });
        return svc.updatePreferences(
          'u',
          dto({ quietHoursStart: start, quietHoursEnd: end }),
        );
      };

      it.each([
        ['22:00', '07:30'], // 9.5h overnight
        ['21:00', '08:00'], // the default, 11h
        ['00:00', '06:00'], // exactly 6h
        ['23:00', '05:00'], // exactly 6h across midnight
      ])('accepts %s → %s', async (s, e) => {
        await expect(put(s, e)).resolves.toMatchObject({ status: 'updated' });
      });

      it.each([
        ['12:00', '13:00'], // 1h
        ['22:00', '02:00'], // 4h across midnight
        ['09:00', '14:59'], // 5h59m
      ])('rejects %s → %s with a 422 field error', async (s, e) => {
        await expect(put(s, e)).rejects.toMatchObject({
          status: 422,
          response: {
            error: 'VALIDATION_FAILED',
            details: [
              expect.objectContaining({
                error: expect.stringMatching(/at least 6 hours/),
              }),
            ],
          },
        });
        expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
      });

      it('validates a one-sided change against the stored other half', async () => {
        // stored end is 08:00; moving only the start to 04:00 leaves a 4h window
        await expect(put('04:00', undefined)).rejects.toMatchObject({
          status: 422,
        });
        await expect(put('22:00', undefined)).resolves.toBeDefined();
      });
    });

    it('warns when email or SMS is disabled, explaining regulatory notices still arrive', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u' });
      const r = (await svc.updatePreferences(
        'u',
        dto({ channels: { sms: false, email: false } }),
      )) as { warnings: string[] };
      expect(r.warnings).toHaveLength(2);
      expect(r.warnings[0]).toMatch(/Email disabled for MKTX/);
      expect(r.warnings[1]).toMatch(/margin calls/);
    });

    it('gives no warnings when nothing regulatory-relevant is disabled', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u' });
      const r = (await svc.updatePreferences(
        'u',
        dto({ channels: { push: false } }),
      )) as { warnings: string[] };
      expect(r.warnings).toEqual([]);
    });
  });
});
