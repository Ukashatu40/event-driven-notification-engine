// tests/unit/events/events.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EventsService } from '../../../src/events/events.service';
import { IngestEventDto } from '../../../src/notifications/dto/ingest-event.dto';

const dto = (over: Partial<IngestEventDto> = {}): IngestEventDto => ({
  eventType: 'RISK-001',
  eventId: 'EVT-1',
  sourceSystem: 'margin_engine',
  timestamp: new Date().toISOString(),
  priority: 1,
  userId: '11111111-1111-4111-8111-111111111111',
  payload: {
    shortfall_amount: 125000,
    current_margin: 375000,
    required_margin: 500000,
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    auto_square_off_time: new Date(Date.now() + 7_200_000).toISOString(),
  },
  idempotencyKey: 'idem-1',
  ...over,
});

describe('EventsService.ingest', () => {
  const prisma = { user: { findUnique: jest.fn() } };
  const kafka = { publish: jest.fn() };
  const resolver = { resolve: jest.fn() };
  const dedup = { claim: jest.fn(), release: jest.fn() };
  const topics = {
    critical: 'notification-critical',
    events: 'notification-events',
  };
  const config = { get: () => topics };
  let service: EventsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: 'u', accountType: 'BASIC' });
    resolver.resolve.mockResolvedValue({ channels: ['sms', 'push'] });
    dedup.claim.mockResolvedValue({ isDuplicate: false });
    kafka.publish.mockResolvedValue([]);
    service = new EventsService(
      prisma as never,
      kafka as never,
      config as never,
      resolver as never,
      dedup as never,
    );
  });

  it('404s an unknown user before touching Kafka or the dedup keys', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.ingest(dto())).rejects.toThrow(NotFoundException);
    expect(dedup.claim).not.toHaveBeenCalled();
    expect(kafka.publish).not.toHaveBeenCalled();
  });

  it('publishes CRITICAL (priority 1) to the dedicated critical topic, keyed by user', async () => {
    const r = await service.ingest(dto());
    const [topic, message] = kafka.publish.mock.calls[0];
    expect(topic).toBe('notification-critical');
    expect(message.key).toBe(dto().userId);
    expect(message.value.notificationId).toBe(r.notification_id);
    expect(r.channels_targeted).toEqual(['sms', 'push']);
  });

  it('publishes non-critical events to the standard topic', async () => {
    await service.ingest(
      dto({
        priority: 3,
        eventType: 'MKTX-003',
        payload: { index: 'NIFTY 50' },
      }),
    );
    expect(kafka.publish.mock.calls[0][0]).toBe('notification-events');
  });

  it('answers a duplicate with the ORIGINAL id and never publishes', async () => {
    dedup.claim.mockResolvedValue({
      isDuplicate: true,
      existingNotificationId: 'orig-1',
    });
    const r = await service.ingest(dto());
    expect(r.notification_id).toBe('orig-1');
    expect(kafka.publish).not.toHaveBeenCalled();
  });

  it('scopes the dedup fingerprint per user (userId:symbol)', async () => {
    await service.ingest(
      dto({
        eventType: 'MKTX-001',
        priority: 2,
        payload: {
          symbol: 'RELIANCE',
          target_price: 2900,
          current_price: 2905,
          direction: 'above',
        },
      }),
    );
    expect(dedup.claim.mock.calls[0][3]).toBe(`${dto().userId}:RELIANCE`);
  });

  it('503s and RELEASES the claim when Kafka rejects the event, so a retry is not called a duplicate', async () => {
    kafka.publish.mockRejectedValue(new Error('broker down'));
    await expect(service.ingest(dto())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(dedup.release).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid payload with 422 field errors BEFORE touching users, dedup or Kafka', async () => {
    const bad = dto({
      payload: { shortfall_amount: -5, deadline: '2020-01-01T00:00:00.000Z' },
    });
    await expect(service.ingest(bad)).rejects.toMatchObject({
      status: 422,
      response: {
        error: 'VALIDATION_FAILED',
        message: 'Event payload validation failed',
      },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(dedup.claim).not.toHaveBeenCalled();
    expect(kafka.publish).not.toHaveBeenCalled();
  });
});
