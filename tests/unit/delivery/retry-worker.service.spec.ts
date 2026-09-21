// tests/unit/delivery/retry-worker.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { RetryWorkerService } from '../../../src/delivery/retry/retry-worker.service';
import { Priority } from '../../../src/shared/constants/priorities';

describe('RetryWorkerService', () => {
  const redis = { zadd: jest.fn(), zrangebyscore: jest.fn(), zrem: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    notification: { update: jest.fn(), findUnique: jest.fn() },
    notificationStateLog: { create: jest.fn() },
    deadLetterQueue: { create: jest.fn() },
  };
  const dispatch = { publishStored: jest.fn() };
  const retryInc = jest.fn();
  const prometheus = { notificationRetryTotal: { inc: retryInc } };
  let worker: RetryWorkerService;

  beforeEach(() => {
    jest.resetAllMocks();
    worker = new RetryWorkerService(
      redis as never,
      prisma,
      dispatch as never,
      prometheus as never,
    );
  });

  it('refuses to schedule beyond the priority max retries (caller dead-letters)', async () => {
    // CRITICAL allows 10 retries
    expect(await worker.scheduleRetry('n', 11, Priority.CRITICAL)).toBe(false);
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it('schedules within the budget on the priority sorted set', async () => {
    expect(await worker.scheduleRetry('n', 1, Priority.HIGH)).toBe(true);
    expect(redis.zadd).toHaveBeenCalledTimes(1);
  });

  it('republishes a due retry to its channel queue (previously it only flipped the status)', async () => {
    redis.zrangebyscore.mockResolvedValueOnce(['n-1']).mockResolvedValue([]);
    prisma.notification.findUnique.mockResolvedValue({
      deliveryAttempts: 2,
      provider: 'msg91',
    });
    dispatch.publishStored.mockResolvedValue(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (worker as any).processDueRetries();

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RETRYING' }),
      }),
    );
    expect(dispatch.publishStored).toHaveBeenCalledWith('n-1');
    expect(retryInc).toHaveBeenCalledWith({ attempt: '2', provider: 'msg91' });
    expect(redis.zrem).toHaveBeenCalled();
  });

  it('dead-letters a retry that has nothing to resend instead of looping forever', async () => {
    redis.zrangebyscore.mockResolvedValueOnce(['n-2']).mockResolvedValue([]);
    dispatch.publishStored.mockResolvedValue(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (worker as any).processDueRetries();

    expect(prisma.deadLetterQueue.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        notificationId: 'n-2',
        lastError: 'REQUEUE_NO_CONTENT',
      }),
    });
  });
});
