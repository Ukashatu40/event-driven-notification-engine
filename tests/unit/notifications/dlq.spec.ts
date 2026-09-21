// tests/unit/notifications/dlq.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { NotificationsService } from '../../../src/notifications/notifications.service';

describe('NotificationsService — DLQ', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    deadLetterQueue: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    notification: { update: jest.fn() },
    notificationStateLog: { create: jest.fn() },
  };
  const dispatch = { publishStored: jest.fn() };
  const gauge = { set: jest.fn() };
  const prometheus = { notificationDlqDepth: gauge };
  let service: NotificationsService;

  const entry = (over = {}) => ({
    id: 'd-1',
    notificationId: 'n-1',
    resolved: false,
    ...over,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.deadLetterQueue.count.mockResolvedValue(3);
    service = new NotificationsService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      dispatch as never,
      prometheus as never,
    );
  });

  describe('listing', () => {
    it('lists only unresolved entries by default', async () => {
      prisma.deadLetterQueue.findMany.mockResolvedValue([]);
      await service.getDlqEntries({ skip: 0, limit: 20, page: 1 });
      expect(prisma.deadLetterQueue.findMany.mock.calls[0][0].where).toEqual({
        resolved: false,
      });
    });

    it('filters by failure classification', async () => {
      prisma.deadLetterQueue.findMany.mockResolvedValue([]);
      await service.getDlqEntries({
        skip: 0,
        limit: 20,
        page: 1,
        classification: 'CONFIGURATION',
      } as never);
      expect(
        prisma.deadLetterQueue.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        resolved: false,
        failureClass: 'CONFIGURATION',
      });
    });

    it('filters by reason, case-insensitively, over the reason and the error code', async () => {
      prisma.deadLetterQueue.findMany.mockResolvedValue([]);
      await service.getDlqEntries({
        skip: 0,
        limit: 20,
        page: 1,
        reason: 'timeout',
      });
      expect(prisma.deadLetterQueue.findMany.mock.calls[0][0].where.OR).toEqual(
        [
          { failureReason: { contains: 'timeout', mode: 'insensitive' } },
          { lastError: { contains: 'timeout', mode: 'insensitive' } },
        ],
      );
    });
  });

  describe('resolve', () => {
    it('404s an unknown entry', async () => {
      prisma.deadLetterQueue.findUnique.mockResolvedValue(null);
      await expect(service.resolveDlqEntry('x', 'discard')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('409s an entry that is already resolved (no double retry)', async () => {
      prisma.deadLetterQueue.findUnique.mockResolvedValue(
        entry({ resolved: true, resolutionAction: 'retry' }),
      );
      await expect(service.resolveDlqEntry('d-1', 'retry')).rejects.toThrow(
        ConflictException,
      );
      expect(dispatch.publishStored).not.toHaveBeenCalled();
    });

    it('discard resolves without sending anything', async () => {
      prisma.deadLetterQueue.findUnique.mockResolvedValue(entry());
      await service.resolveDlqEntry('d-1', 'discard', 'ops-1');
      expect(dispatch.publishStored).not.toHaveBeenCalled();
      expect(prisma.deadLetterQueue.update).toHaveBeenCalledWith({
        where: { id: 'd-1' },
        data: expect.objectContaining({
          resolved: true,
          resolvedBy: 'ops-1',
          resolutionAction: 'discard',
        }),
      });
    });

    it('retry republishes FIRST, records the transition, and only then marks resolved', async () => {
      prisma.deadLetterQueue.findUnique.mockResolvedValue(entry());
      dispatch.publishStored.mockResolvedValue(true);

      await service.resolveDlqEntry('d-1', 'retry', 'ops-1');

      expect(prisma.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'RETRYING' }),
        }),
      );
      expect(dispatch.publishStored).toHaveBeenCalledWith('n-1');
      expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromStatus: 'DLQ',
          toStatus: 'RETRYING',
          actor: 'dlq_manual_retry',
        }),
      });
      const queued = dispatch.publishStored.mock.invocationCallOrder[0];
      const resolved =
        prisma.deadLetterQueue.update.mock.invocationCallOrder[0];
      expect(queued).toBeLessThan(resolved);
    });

    it('a retry that cannot be queued leaves the entry OPEN and restores DLQ (the old code marked it resolved, then threw)', async () => {
      prisma.deadLetterQueue.findUnique.mockResolvedValue(entry());
      dispatch.publishStored.mockResolvedValue(false);

      await expect(service.resolveDlqEntry('d-1', 'retry')).rejects.toThrow(
        UnprocessableEntityException,
      );

      expect(prisma.deadLetterQueue.update).not.toHaveBeenCalled();
      const last = prisma.notification.update.mock.calls.at(-1)[0];
      expect(last.data.status).toBe('DLQ');
    });

    it('updates the DLQ depth gauge so the HighDLQDepth alert reflects resolutions', async () => {
      prisma.deadLetterQueue.findUnique.mockResolvedValue(entry());
      await service.resolveDlqEntry('d-1', 'discard');
      expect(gauge.set).toHaveBeenCalledWith(3);
    });
  });
});
