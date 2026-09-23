// tests/unit/delivery/delivery-worker.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { DeliveryWorkerService } from '../../../src/delivery/workers/delivery-worker.service';

type Handler = (
  msg: Record<string, unknown>,
  ack: () => void,
  nack: (requeue?: boolean) => void,
) => Promise<void>;

describe('DeliveryWorkerService', () => {
  const consume = jest.fn();
  const process = jest.fn();
  const queues = {
    sms: { name: 'notifications.sms', prefetch: 50 },
    email: { name: 'notifications.email', prefetch: 100 },
    retry: { name: 'notifications.retry', prefetch: 20 },
  };
  const config = (extra: Record<string, unknown> = {}) => ({
    get: (k: string) => ({ 'rabbitmq.queues': queues, ...extra })[k],
  });

  const build = (extra?: Record<string, unknown>) =>
    new DeliveryWorkerService(
      { consume } as never,
      { process } as never,
      config(extra) as never,
    );

  beforeEach(() => jest.resetAllMocks());

  it('consumes every channel queue but not the retry queue', async () => {
    await build().onApplicationBootstrap();
    expect(consume.mock.calls.map((c) => c[0])).toEqual([
      'notifications.sms',
      'notifications.email',
    ]);
    expect(consume).toHaveBeenCalledWith(
      'notifications.sms',
      50,
      expect.any(Function),
    );
  });

  it('does nothing when DELIVERY_WORKERS_ENABLED=false', async () => {
    await build({ DELIVERY_WORKERS_ENABLED: 'false' }).onApplicationBootstrap();
    expect(consume).not.toHaveBeenCalled();
  });

  it('acks after a successful process()', async () => {
    await build().onApplicationBootstrap();
    const handler = consume.mock.calls[0][2] as Handler;
    const ack = jest.fn();
    const nack = jest.fn();
    process.mockResolvedValue(undefined);

    await handler({ notificationId: 'n-1' }, ack, nack);

    expect(process).toHaveBeenCalledWith({ notificationId: 'n-1' });
    expect(ack).toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
  });

  it('nacks WITHOUT requeue when process() throws, so a poison message cannot loop', async () => {
    await build().onApplicationBootstrap();
    const handler = consume.mock.calls[0][2] as Handler;
    const ack = jest.fn();
    const nack = jest.fn();
    process.mockRejectedValue(new Error('boom'));

    await handler({ notificationId: 'n-2' }, ack, nack);

    expect(nack).toHaveBeenCalledWith(false);
    expect(ack).not.toHaveBeenCalled();
  });
});
