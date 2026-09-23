// tests/unit/events/ingestion-consumer.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { IngestionConsumerService } from '../../../src/events/ingestion-consumer.service';

describe('IngestionConsumerService (Kafka → engine)', () => {
  const kafka = { subscribe: jest.fn(), publish: jest.fn() };
  const engine = { process: jest.fn() };
  const topics = {
    critical: 'notification-critical',
    events: 'notification-events',
    dlq: 'notification-dlq',
  };
  const groups = { critical: 'critical-cg', standard: 'standard-cg' };
  const cfg = (extra: Record<string, unknown> = {}) => ({
    get: (k: string) =>
      ({ 'kafka.topics': topics, 'kafka.groupIds': groups, ...extra })[k],
  });
  const build = (extra?: Record<string, unknown>) =>
    new IngestionConsumerService(
      kafka as never,
      engine as never,
      cfg(extra) as never,
    );
  const envelope = {
    notificationId: 'n-1',
    correlationId: 'c-1',
    event: { eventId: 'E-1', userId: 'u-1' },
  };

  /** Boot the consumer and return the handler it registered for a topic. */
  const handler = async (idx = 0) => {
    await build().onApplicationBootstrap();
    return kafka.subscribe.mock.calls[idx][2] as (
      t: string,
      p: number,
      m: Record<string, unknown>,
      h: Record<string, string>,
    ) => Promise<void>;
  };

  beforeEach(() => jest.resetAllMocks());

  it('runs CRITICAL and standard traffic in SEPARATE consumer groups on separate topics (Case Study C4)', async () => {
    await build().onApplicationBootstrap();
    expect(kafka.subscribe).toHaveBeenCalledTimes(2);
    expect(kafka.subscribe.mock.calls[0].slice(0, 2)).toEqual([
      'critical-cg',
      ['notification-critical'],
    ]);
    expect(kafka.subscribe.mock.calls[1].slice(0, 2)).toEqual([
      'standard-cg',
      ['notification-events'],
    ]);
  });

  it('subscribes to nothing when KAFKA_CONSUMERS_ENABLED=false (API-only replica)', async () => {
    await build({ KAFKA_CONSUMERS_ENABLED: 'false' }).onApplicationBootstrap();
    expect(kafka.subscribe).not.toHaveBeenCalled();
  });

  it('hands each envelope to the engine with the id already given to the API caller', async () => {
    const h = await handler();
    await h('notification-critical', 0, envelope, {});
    expect(engine.process).toHaveBeenCalledWith(envelope.event, 'c-1', 'n-1');
  });

  it('falls back to the Kafka correlation-id header when the envelope has none', async () => {
    const h = await handler();
    await h(
      't',
      0,
      { ...envelope, correlationId: undefined },
      { 'correlation-id': 'from-header' },
    );
    expect(engine.process).toHaveBeenCalledWith(
      envelope.event,
      'from-header',
      'n-1',
    );
  });

  it('PARKS a poison message on the DLQ topic instead of losing it or blocking the partition', async () => {
    engine.process.mockRejectedValue(new Error('db exploded'));
    const h = await handler();

    await expect(
      h('notification-events', 3, envelope, {}),
    ).resolves.toBeUndefined(); // offset can now be committed

    expect(kafka.publish).toHaveBeenCalledWith(
      'notification-dlq',
      {
        key: 'u-1',
        value: expect.objectContaining({
          failedTopic: 'notification-events',
          error: 'db exploded',
          notificationId: 'n-1',
        }),
      },
      'c-1',
    );
  });

  it('surfaces a failure to park the message (so the offset is NOT silently committed)', async () => {
    engine.process.mockRejectedValue(new Error('x'));
    kafka.publish.mockRejectedValue(new Error('kafka down'));
    const h = await handler();
    await expect(h('t', 0, envelope, {})).rejects.toThrow('kafka down');
  });
});
