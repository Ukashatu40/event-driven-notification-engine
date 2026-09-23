// tests/unit/notifications/state.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { StateService } from '../../../src/notifications/state-machine/state.service';
import { NotificationStatus as S } from '../../../src/shared/constants/notification-states';

describe('StateService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    notification: { findUnique: jest.fn(), update: jest.fn() },
    notificationStateLog: { create: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const gateway = { broadcastStateChange: jest.fn() };
  const svc = new StateService(prisma, gateway as never);
  const row = (status: string) => ({
    status,
    userId: 'u-1',
    eventType: 'RISK-001',
    channel: 'sms',
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockResolvedValue([]);
  });

  it('persists the status and the audit-log entry in ONE transaction', async () => {
    prisma.notification.findUnique.mockResolvedValue(row(S.ROUTED));
    await svc.transition('n-1', S.QUEUED, 'rabbitmq_publisher', {
      channel: 'sms',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'n-1' },
        data: expect.objectContaining({ status: 'QUEUED' }),
      }),
    );
    expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
      data: {
        notificationId: 'n-1',
        fromStatus: 'ROUTED',
        toStatus: 'QUEUED',
        actor: 'rabbitmq_publisher',
        metadata: { channel: 'sms' },
      },
    });
  });

  it('broadcasts the change to the live dashboard', async () => {
    prisma.notification.findUnique.mockResolvedValue(row(S.ROUTED));
    await svc.transition('n-1', S.QUEUED, 'x');
    expect(gateway.broadcastStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'n-1',
        fromStatus: 'ROUTED',
        toStatus: 'QUEUED',
        userId: 'u-1',
      }),
    );
  });

  it('REFUSES an illegal transition and writes nothing', async () => {
    prisma.notification.findUnique.mockResolvedValue(row(S.DELIVERED));
    await expect(svc.transition('n-1', S.QUEUED, 'x')).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(gateway.broadcastStateChange).not.toHaveBeenCalled();
  });

  it('errors for an unknown notification', async () => {
    prisma.notification.findUnique.mockResolvedValue(null);
    await expect(svc.transition('nope', S.QUEUED, 'x')).rejects.toThrow(
      /not found/,
    );
  });

  it('returns the history oldest-first from the state log', async () => {
    prisma.notificationStateLog.findMany.mockResolvedValue([
      { toStatus: 'ENRICHED' },
    ]);
    expect(await svc.getHistory('n-1')).toEqual([{ toStatus: 'ENRICHED' }]);
    expect(prisma.notificationStateLog.findMany.mock.calls[0][0].where).toEqual(
      { notificationId: 'n-1' },
    );
  });
});
