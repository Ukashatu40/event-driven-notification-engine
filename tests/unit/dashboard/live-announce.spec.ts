// tests/unit/dashboard/live-announce.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { DashboardGateway } from '../../../src/dashboard/dashboard.gateway';
import { DeliveryService } from '../../../src/delivery/delivery.service';

const gateway = (enabled: boolean, server: unknown) => {
  const g = new DashboardGateway(
    { get: () => enabled } as never,
    {} as never,
    {} as never,
  );
  (g as unknown as { server: unknown }).server = server;
  return g;
};

describe('DashboardGateway.isWatched', () => {
  // Regression: for a namespaced gateway Nest injects a socket.io Namespace, whose
  // `sockets` is the Map of clients. Reading `server.sockets.sockets` made this
  // always false, so the delivery half of the lifecycle was never announced.
  it('sees clients on a Namespace (sockets is a Map)', () => {
    expect(gateway(true, { sockets: new Map([['a', {}]]) }).isWatched()).toBe(
      true,
    );
    expect(gateway(true, { sockets: new Map() }).isWatched()).toBe(false);
  });

  it('sees clients on a bare Server (sockets is the main namespace)', () => {
    const server = { sockets: { sockets: new Map([['a', {}]]) } };
    expect(gateway(true, server).isWatched()).toBe(true);
  });

  it('is false when the feature is off or there is no server yet', () => {
    expect(gateway(false, { sockets: new Map([['a', {}]]) }).isWatched()).toBe(
      false,
    );
    expect(gateway(true, undefined).isWatched()).toBe(false);
  });
});

describe('DeliveryService.announce', () => {
  const prisma = { notification: { findUnique: jest.fn() } };
  const dashboard = { isWatched: jest.fn(), broadcastStateChange: jest.fn() };
  const announce = (d: unknown) =>
    (
      new DeliveryService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        d as never,
      ) as unknown as { announce: (...a: unknown[]) => Promise<void> }
    ).announce('n-1', 'SENT', 'DELIVERED');

  beforeEach(() => jest.resetAllMocks());

  it('broadcasts the transition when someone is watching', async () => {
    dashboard.isWatched.mockReturnValue(true);
    prisma.notification.findUnique.mockResolvedValue({
      userId: 'u-1',
      eventType: 'RISK-001',
      channel: 'sms',
    });

    await announce(dashboard);

    expect(dashboard.broadcastStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'n-1',
        userId: 'u-1',
        channel: 'sms',
        fromStatus: 'SENT',
        toStatus: 'DELIVERED',
      }),
    );
  });

  it('does no database work when nobody is watching', async () => {
    dashboard.isWatched.mockReturnValue(false);
    await announce(dashboard);
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    expect(dashboard.broadcastStateChange).not.toHaveBeenCalled();
  });

  it('never lets a dashboard failure break delivery', async () => {
    dashboard.isWatched.mockReturnValue(true);
    prisma.notification.findUnique.mockRejectedValue(new Error('db down'));
    await expect(announce(dashboard)).resolves.toBeUndefined();
  });

  it('works when the dashboard module is absent', async () => {
    await expect(announce(undefined)).resolves.toBeUndefined();
  });
});
