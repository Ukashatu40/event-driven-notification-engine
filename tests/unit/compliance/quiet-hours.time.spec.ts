// tests/unit/compliance/quiet-hours.time.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { QuietHoursService } from '../../../src/compliance/quiet-hours/quiet-hours.service';

describe('QuietHoursService — timezone-aware windows (spec A6.3)', () => {
  type Held = { suppressed: true; reason: string; deliverAt: string };
  const findUnique = jest.fn();
  const redis = {
    zadd: jest.fn(),
    zrangebyscore: jest.fn(),
    zrem: jest.fn(),
    zcount: jest.fn(),
  };
  const svc = new QuietHoursService(
    redis as never,
    { user: { findUnique } } as never,
  );

  const at = (iso: string) => jest.useFakeTimers().setSystemTime(new Date(iso));
  const user = (over = {}) =>
    findUnique.mockResolvedValue({
      timezone: 'Africa/Lagos',
      quietHoursStart: '21:00',
      quietHoursEnd: '08:00',
      ...over,
    });

  beforeEach(() => jest.resetAllMocks());
  afterEach(() => jest.useRealTimers());

  describe('is the user inside their window?', () => {
    // Lagos is UTC+1 (no DST)
    it.each([
      ['2026-09-21T22:30:00Z', true], // 23:30 Lagos
      ['2026-09-21T03:00:00Z', true], // 04:00 Lagos
      ['2026-09-21T06:59:00Z', true], // 07:59 Lagos — one minute before the window ends
      ['2026-09-21T07:00:00Z', false], // 08:00 Lagos — window over
      ['2026-09-21T12:00:00Z', false], // 13:00 Lagos
      ['2026-09-21T19:59:00Z', false], // 20:59 Lagos — one minute before it starts
      ['2026-09-21T20:00:00Z', true], // 21:00 Lagos
    ])('%s → quiet=%s', async (iso, quiet) => {
      at(iso);
      user();
      expect((await svc.check('u', 'MKTX-004')).suppressed).toBe(quiet);
    });

    it("uses the USER's timezone: the same instant is quiet in Lagos but not in Kolkata", async () => {
      at('2026-09-21T20:30:00Z'); // 21:30 Lagos, 02:00 next day Kolkata (quiet there too) → pick another instant
      at('2026-09-21T16:00:00Z'); // 17:00 Lagos (active)  /  21:30 Kolkata (quiet)
      user({ timezone: 'Africa/Lagos' });
      expect((await svc.check('u', 'MKTX-004')).suppressed).toBe(false);
      user({ timezone: 'Asia/Kolkata' });
      expect((await svc.check('u', 'MKTX-004')).suppressed).toBe(true);
    });

    it('handles a same-day window that does not cross midnight', async () => {
      at('2026-09-21T13:00:00Z'); // 14:00 Lagos
      user({ quietHoursStart: '13:00', quietHoursEnd: '17:00' });
      expect((await svc.check('u', 'MKTX-004')).suppressed).toBe(true);
      user({ quietHoursStart: '15:00', quietHoursEnd: '19:00' });
      expect((await svc.check('u', 'MKTX-004')).suppressed).toBe(false);
    });
  });

  describe('when to deliver', () => {
    it('is the end of the window: tonight → 08:00 Lagos the next morning', async () => {
      at('2026-09-21T22:30:00Z'); // 23:30 Lagos
      user();
      const r = (await svc.check('u', 'MKTX-004')) as Held;
      expect(r).toMatchObject({
        suppressed: true,
        reason: 'WITHIN_QUIET_HOURS',
      });
      expect(r.deliverAt).toBe('2026-09-22T07:00:00.000Z'); // 08:00 Lagos
    });

    it('is later the SAME morning when the user is in the small hours', async () => {
      at('2026-09-22T03:00:00Z'); // 04:00 Lagos
      user();
      expect(((await svc.check('u', 'MKTX-004')) as Held).deliverAt).toBe(
        '2026-09-22T07:00:00.000Z',
      );
    });
  });

  it('CRITICAL events are never held, even at 3am', async () => {
    at('2026-09-22T02:00:00Z');
    user();
    for (const e of ['RISK-001', 'RISK-002', 'RISK-003', 'MKTX-002'] as const) {
      expect((await svc.check('u', e)).suppressed).toBe(false);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not suppress for an unknown user', async () => {
    findUnique.mockResolvedValue(null);
    expect((await svc.check('ghost', 'MKTX-004')).suppressed).toBe(false);
  });

  describe('the queue', () => {
    it('queues by delivery time, lists what is due, removes, and reports depth', async () => {
      await svc.queue('u', 'n-1', new Date('2026-09-22T07:00:00Z'));
      expect(redis.zadd).toHaveBeenCalledWith(
        expect.stringContaining('u'),
        new Date('2026-09-22T07:00:00Z').getTime(),
        'n-1',
      );

      redis.zrangebyscore.mockResolvedValue(['n-1']);
      expect(await svc.getDueNotifications('u')).toEqual(['n-1']);

      await svc.removeFromQueue('u', 'n-1');
      expect(redis.zrem).toHaveBeenCalledWith(
        expect.stringContaining('u'),
        'n-1',
      );

      redis.zcount.mockResolvedValue(7);
      expect(await svc.getQueueDepth('u')).toBe(7);
    });

    it('batches into a digest when MORE than 5 are queued (spec A6.3: "exceeds 5")', () => {
      expect(svc.shouldBatchIntoDig(4)).toBe(false);
      expect(svc.shouldBatchIntoDig(5)).toBe(false); // spec: EXCEEDS 5
      expect(svc.shouldBatchIntoDig(6)).toBe(true);
    });
  });
});
