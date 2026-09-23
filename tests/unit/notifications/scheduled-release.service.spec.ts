// tests/unit/notifications/scheduled-release.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { ScheduledReleaseService } from '../../../src/notifications/engine/scheduled-release.service';
import { REDIS_KEYS } from '../../../src/shared/constants/redis-keys';

describe('ScheduledReleaseService.releaseDue', () => {
  const zrem = jest.fn();
  const redis = {
    zrangebyscore: jest.fn(),
    zadd: jest.fn(),
    getClient: () => ({ zrem }),
  };
  const engine = { resume: jest.fn(), deferToDigest: jest.fn() };
  const quietHours = {
    getQueueDepth: jest.fn(),
    shouldBatchIntoDig: jest.fn(),
  };
  let service: ScheduledReleaseService;

  const member = (id: string, channels = ['push'], extra: object = {}) =>
    JSON.stringify({ id, channels, ...extra });

  beforeEach(() => {
    jest.resetAllMocks();
    service = new ScheduledReleaseService(
      redis as never,
      engine as never,
      { get: () => undefined } as never,
      quietHours as never,
    );
  });

  it('resumes each due notification with its stored channels', async () => {
    redis.zrangebyscore.mockResolvedValue([member('a', ['push', 'sms'])]);
    zrem.mockResolvedValue(1);

    const released = await service.releaseDue();

    expect(released).toBe(1);
    expect(zrem).toHaveBeenCalledWith(
      REDIS_KEYS.scheduledRelease,
      member('a', ['push', 'sms']),
    );
    expect(engine.resume).toHaveBeenCalledWith('a', ['push', 'sms']);
  });

  it('skips a member another replica already claimed (ZREM returned 0) — no double dispatch', async () => {
    redis.zrangebyscore.mockResolvedValue([member('a')]);
    zrem.mockResolvedValue(0);

    expect(await service.releaseDue()).toBe(0);
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('reschedules a release that failed instead of losing it', async () => {
    redis.zrangebyscore.mockResolvedValue([member('a')]);
    zrem.mockResolvedValue(1);
    engine.resume.mockRejectedValue(new Error('db down'));

    expect(await service.releaseDue()).toBe(0);
    expect(redis.zadd).toHaveBeenCalledWith(
      REDIS_KEYS.scheduledRelease,
      expect.any(Number),
      member('a'),
    );
  });

  it('does nothing when nothing is due', async () => {
    redis.zrangebyscore.mockResolvedValue([]);
    expect(await service.releaseDue()).toBe(0);
    expect(zrem).not.toHaveBeenCalled();
  });

  describe('quiet-hours pile-up → one morning digest (spec A6.3)', () => {
    const quiet = (id: string, userId = 'u-1') =>
      member(id, ['push'], { kind: 'quiet', userId });

    beforeEach(() => {
      zrem.mockResolvedValue(1);
      quietHours.shouldBatchIntoDig.mockImplementation((n: number) => n > 5);
    });

    it('sends them to the digest when MORE than 5 built up overnight', async () => {
      redis.zrangebyscore.mockResolvedValue([quiet('a'), quiet('b')]);
      quietHours.getQueueDepth.mockResolvedValue(8);
      await service.releaseDue();
      expect(
        engine.deferToDigest.mock.calls.map((c: string[]) => c[0]),
      ).toEqual(['a', 'b']);
      expect(engine.resume).not.toHaveBeenCalled();
    });

    it('releases them individually at 5 or fewer', async () => {
      redis.zrangebyscore.mockResolvedValue([quiet('a')]);
      quietHours.getQueueDepth.mockResolvedValue(5);
      await service.releaseDue();
      expect(engine.resume).toHaveBeenCalledWith('a', ['push']);
      expect(engine.deferToDigest).not.toHaveBeenCalled();
    });

    it('snapshots the depth BEFORE releasing, so a big pile is not split halfway (8 → digest all 8, not 3 digested + 5 sent)', async () => {
      redis.zrangebyscore.mockResolvedValue(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((i) => quiet(i)),
      );
      quietHours.getQueueDepth.mockResolvedValue(8); // queried once; it would shrink as items leave
      await service.releaseDue();
      expect(quietHours.getQueueDepth).toHaveBeenCalledTimes(1);
      expect(engine.deferToDigest).toHaveBeenCalledTimes(8);
      expect(engine.resume).not.toHaveBeenCalled();
    });

    it("decides per user: one user's pile-up does not digest another's single notification", async () => {
      redis.zrangebyscore.mockResolvedValue([
        quiet('a', 'u-1'),
        quiet('b', 'u-2'),
      ]);
      quietHours.getQueueDepth.mockImplementation(async (u: string) =>
        u === 'u-1' ? 9 : 1,
      );
      await service.releaseDue();
      expect(engine.deferToDigest).toHaveBeenCalledWith('a');
      expect(engine.resume).toHaveBeenCalledWith('b', ['push']);
    });

    it('never digests send-time-optimised or legacy (no kind) entries', async () => {
      redis.zrangebyscore.mockResolvedValue([
        member('s', ['push'], { kind: 'sto', userId: 'u-1' }),
        member('legacy'),
      ]);
      quietHours.getQueueDepth.mockResolvedValue(20);
      await service.releaseDue();
      expect(engine.resume).toHaveBeenCalledTimes(2);
      expect(engine.deferToDigest).not.toHaveBeenCalled();
    });
  });
});
