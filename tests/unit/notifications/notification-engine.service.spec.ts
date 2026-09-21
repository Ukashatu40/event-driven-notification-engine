// tests/unit/notifications/notification-engine.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { NotificationEngineService } from '../../../src/notifications/engine/notification-engine.service';
import { IngestEventDto } from '../../../src/notifications/dto/ingest-event.dto';

const USER = {
  id: 'u-1',
  name: 'Ada',
  phone: 'enc',
  email: 'enc',
  language: 'YO',
  timezone: 'Africa/Lagos',
  accountType: 'BASIC',
  market: 'NG',
};

const dto = (over: Partial<IngestEventDto> = {}): IngestEventDto => ({
  eventType: 'TXNX-005',
  eventId: 'EVT-1',
  sourceSystem: 'paystack',
  timestamp: new Date().toISOString(),
  priority: 2,
  userId: 'u-1',
  payload: { amount: 5000, source: 'Paystack' },
  idempotencyKey: 'idem-1',
  ...over,
});

describe('NotificationEngineService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    user: { findUnique: jest.fn() },
    notification: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    notificationStateLog: { create: jest.fn() },
  };
  const redis = { zadd: jest.fn() };
  const config = {
    get: (k: string) => (k === 'app.name' ? 'WealthBridge' : undefined),
  };
  const prometheus = { notificationEventsReceived: { inc: jest.fn() } };
  const dedup = { check: jest.fn(), register: jest.fn() };
  const state = { transition: jest.fn() };
  const routing = { route: jest.fn() };
  const templates = { render: jest.fn(), supportsChannel: jest.fn() };
  const freq = { record: jest.fn() };
  const quiet = {
    queue: jest.fn(),
    removeFromQueue: jest.fn(),
    nextActiveWindowStart: jest.fn(),
  };
  const buckets = { add: jest.fn() };
  const classifier = { classify: jest.fn() };
  const delivery = { deadLetter: jest.fn() };
  const dispatch = { publish: jest.fn() };
  const ab = { resolveVariant: jest.fn(), recordExposure: jest.fn() };
  const sto = { decide: jest.fn() };
  let engine: NotificationEngineService;

  const decision = (over = {}) => ({
    channels: ['sms', 'push'],
    suppressedChannels: [],
    regulatoryOverride: false,
    ...over,
  });
  const published = () =>
    dispatch.publish.mock.calls.map((c: any[]) => c[0].channel);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.notification.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(USER);
    dedup.check.mockResolvedValue({ isDuplicate: false });
    classifier.classify.mockReturnValue('TRANSACTIONAL');
    routing.route.mockResolvedValue(decision());
    templates.supportsChannel.mockReturnValue(true);
    templates.render.mockResolvedValue({
      channel: 'sms',
      body: 'hello',
      title: 't',
    });
    ab.resolveVariant.mockResolvedValue({ templateId: 'TXNX-005-v1' });
    sto.decide.mockResolvedValue({ optimize: false });
    quiet.nextActiveWindowStart.mockReturnValue(
      new Date('2026-09-22T07:00:00.000Z'),
    );

    engine = new NotificationEngineService(
      prisma,
      redis as never,
      config as never,
      prometheus as never,
      dedup as never,
      state as never,
      routing as never,
      templates as never,
      freq as never,
      quiet as never,
      classifier as never,
      delivery as never,
      dispatch as never,
      ab as never,
      sto as never,
      buckets as never,
    );
  });

  describe('deduplication', () => {
    it('returns the original id for a duplicate and does nothing else', async () => {
      dedup.check.mockResolvedValue({
        isDuplicate: true,
        existingNotificationId: 'orig',
        reason: 'X',
      });
      const r = await engine.process(dto(), 'c-1', 'new-id');
      expect(r).toEqual({ notificationId: 'orig', channelsTargeted: [] });
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('treats a duplicate that points at OUR OWN id as a Kafka redelivery, not a duplicate', async () => {
      dedup.check.mockResolvedValue({
        isDuplicate: true,
        existingNotificationId: 'mine',
      });
      await engine.process(dto(), 'c-1', 'mine');
      expect(prisma.notification.create).toHaveBeenCalled();
    });

    it('scopes the fingerprint per user (userId:reference)', async () => {
      await engine.process(
        dto({ payload: { reference: 'R-9', amount: 1 } }),
        'c-1',
      );
      expect(dedup.check.mock.calls[0][3]).toBe('u-1:R-9');
    });

    it('is a no-op when the notification has already progressed past CREATED', async () => {
      prisma.notification.findUnique.mockResolvedValue({ status: 'SENT' });
      const r = await engine.process(dto(), 'c-1', 'n-1');
      expect(r.channelsTargeted).toEqual([]);
      expect(routing.route).not.toHaveBeenCalled();
    });

    it('resumes an interrupted CREATED notification without creating it twice', async () => {
      prisma.notification.findUnique.mockResolvedValue({ status: 'CREATED' });
      await engine.process(dto(), 'c-1', 'n-1');
      // only the sibling row for the second channel is created — never the parent again
      const createdIds = prisma.notification.create.mock.calls.map(
        (c: any[]) => c[0].data.id,
      );
      expect(createdIds).not.toContain('n-1');
      expect(routing.route).toHaveBeenCalled();
    });
  });

  it('drops an event for an unknown user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const r = await engine.process(dto(), 'c-1', 'n-1');
    expect(r.channelsTargeted).toEqual([]);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  describe('happy path', () => {
    it('creates the record with the classification, then fans out ONE row per channel', async () => {
      const r = await engine.process(dto(), 'c-1', 'n-1');

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'n-1',
          eventType: 'TXNX-005',
          classification: 'TRANSACTIONAL',
          status: 'CREATED',
        }),
      });
      expect(r).toEqual({
        notificationId: 'n-1',
        channelsTargeted: ['sms', 'push'],
      });
      // first channel reuses the row; the second gets a sibling row
      expect(prisma.notification.create).toHaveBeenCalledTimes(2);
      const sibling = prisma.notification.create.mock.calls[1][0].data;
      expect(sibling).toMatchObject({
        channel: 'push',
        status: 'ROUTED',
        metadata: { parentNotificationId: 'n-1' },
      });
      expect(published()).toEqual(['sms', 'push']);
    });

    it('advances ENRICHED → ROUTED → QUEUED for each channel via the state machine', async () => {
      await engine.process(dto(), 'c-1', 'n-1');
      const to = state.transition.mock.calls.map((c: any[]) => c[1]);
      expect(to.slice(0, 3)).toEqual(['ENRICHED', 'ROUTED', 'QUEUED']);
    });

    it('puts a user REFERENCE on the queue, never the phone or email', async () => {
      await engine.process(dto(), 'c-1', 'n-1');
      for (const [msg] of dispatch.publish.mock.calls) {
        expect(msg.recipient).toBe('user:u-1');
        expect(JSON.stringify(msg)).not.toContain('enc');
      }
    });

    it("renders in the user's language with their market currency", async () => {
      await engine.process(dto(), 'c-1', 'n-1');
      expect(templates.render).toHaveBeenCalledWith(
        'TXNX-005-v1',
        'sms',
        expect.objectContaining({
          language: 'yo',
          currency: 'NGN',
          timezone: 'Africa/Lagos',
          appName: 'WealthBridge',
        }),
      );
    });

    it('counts the event once against the caps, other channels only against their own', async () => {
      await engine.process(dto(), 'c-1', 'n-1');
      expect(freq.record.mock.calls.map((c: any[]) => [c[2], c[3]])).toEqual([
        ['sms', true],
        ['push', false],
      ]);
    });

    it('records the frequency-cap and regulatory compliance fields', async () => {
      routing.route.mockResolvedValue(decision({ regulatoryOverride: true }));
      await engine.process(dto(), 'c-1', 'n-1');
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'n-1' },
        data: {
          regulatoryOverride: true,
          frequencyCapChecked: true,
          frequencyCapResult: 'WITHIN_LIMITS',
        },
      });
    });
  });

  describe('channels a template cannot serve', () => {
    it('skips them (recorded as suppressed) instead of dead-lettering', async () => {
      templates.supportsChannel.mockImplementation(
        (_e: string, c: string) => c !== 'sms',
      );
      const r = await engine.process(dto(), 'c-1', 'n-1');
      expect(r.channelsTargeted).toEqual(['push']);
      expect(delivery.deadLetter).not.toHaveBeenCalled();
      expect(state.transition.mock.calls[1][3]).toMatchObject({
        suppressedChannels: [
          { channel: 'sms', reason: 'NO_TEMPLATE_FOR_CHANNEL' },
        ],
      });
    });
  });

  describe('suppression', () => {
    it('CAPPED when every channel was suppressed by frequency caps', async () => {
      routing.route.mockResolvedValue(
        decision({
          channels: [],
          suppressedChannels: [{ channel: 'sms', reason: 'Cooldown active' }],
        }),
      );
      const r = await engine.process(dto(), 'c-1', 'n-1');
      expect(state.transition).toHaveBeenLastCalledWith(
        'n-1',
        'CAPPED',
        'routing_engine',
        expect.any(Object),
      );
      expect(r.channelsTargeted).toEqual([]);
      expect(
        prisma.notification.update.mock.calls[0][0].data.frequencyCapResult,
      ).toBe('CAPPED');
    });

    it('defers to QUIET and schedules a release for the channels that can be served', async () => {
      routing.route.mockResolvedValue(
        decision({
          channels: [],
          suppressedChannels: [
            { channel: 'push', reason: 'QUIET_HOURS' },
            { channel: 'sms', reason: 'QUIET_HOURS' },
          ],
          quietHoursDelay: { deliverAt: '2026-09-22T07:00:00.000Z' },
        }),
      );
      templates.supportsChannel.mockImplementation(
        (_e: string, c: string) => c === 'push',
      );

      const r = await engine.process(dto(), 'c-1', 'n-1');

      expect(state.transition).toHaveBeenCalledWith(
        'n-1',
        'QUIET',
        'quiet_hours_service',
        expect.any(Object),
      );
      expect(quiet.queue).toHaveBeenCalled();
      expect(redis.zadd).toHaveBeenCalledWith(
        expect.any(String),
        new Date('2026-09-22T07:00:00.000Z').getTime(),
        JSON.stringify({
          id: 'n-1',
          channels: ['push'],
          kind: 'quiet',
          userId: 'u-1',
        }),
      );
      expect(r.channelsTargeted).toEqual([]);
      expect(dispatch.publish).not.toHaveBeenCalled();
    });

    it('does not defer an empty list: quiet hours with nothing servable ends CAPPED', async () => {
      routing.route.mockResolvedValue(
        decision({
          channels: [],
          suppressedChannels: [{ channel: 'sms', reason: 'QUIET_HOURS' }],
          quietHoursDelay: { deliverAt: '2026-09-22T07:00:00.000Z' },
        }),
      );
      templates.supportsChannel.mockReturnValue(false);
      await engine.process(dto(), 'c-1', 'n-1');
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(state.transition).toHaveBeenLastCalledWith(
        'n-1',
        'CAPPED',
        'routing_engine',
        expect.any(Object),
      );
    });
  });

  describe('send-time optimisation', () => {
    it('defers to ROUTED and schedules a release', async () => {
      sto.decide.mockResolvedValue({
        optimize: true,
        delayMs: 600_000,
        reason: 'user opens at 9',
      });
      const r = await engine.process(dto(), 'c-1', 'n-1');
      expect(state.transition).toHaveBeenLastCalledWith(
        'n-1',
        'ROUTED',
        'send-time-optimizer',
        expect.objectContaining({ reason: 'user opens at 9' }),
      );
      expect(redis.zadd).toHaveBeenCalledTimes(1);
      expect(dispatch.publish).not.toHaveBeenCalled();
      expect(r.channelsTargeted).toEqual(['sms', 'push']);
    });
  });

  describe('audit of policy bypasses', () => {
    it('records what a CRITICAL event skipped in the ENRICHED state-log entry', async () => {
      routing.route.mockResolvedValue(
        decision({ policyBypasses: ['frequency_cap', 'quiet_hours'] }),
      );
      await engine.process(
        dto({ eventType: 'RISK-001', priority: 1 }),
        'c-1',
        'n-1',
      );
      expect(state.transition.mock.calls[0]).toEqual([
        'n-1',
        'ENRICHED',
        'enrichment_worker',
        expect.objectContaining({
          policyBypasses: ['frequency_cap', 'quiet_hours'],
        }),
      ]);
    });
  });

  describe('failures are never swallowed', () => {
    it('dead-letters a channel that fails to render, and keeps going with the others', async () => {
      templates.render
        .mockRejectedValueOnce(new Error('bad template'))
        .mockResolvedValue({ channel: 'push', body: 'ok' });
      const r = await engine.process(dto(), 'c-1', 'n-1');
      expect(delivery.deadLetter).toHaveBeenCalledWith(
        'n-1',
        expect.any(Object),
        { message: 'bad template', code: 'RENDER_OR_QUEUE_FAILED' },
      );
      expect(published()).toEqual(['push']);
      expect(r.channelsTargeted).toEqual(['sms', 'push']);
    });

    it('dead-letters when the broker publish fails', async () => {
      dispatch.publish.mockRejectedValueOnce(new Error('amqp down'));
      await engine.process(dto(), 'c-1', 'n-1');
      expect(delivery.deadLetter).toHaveBeenCalledWith(
        'n-1',
        expect.any(Object),
        expect.objectContaining({ message: 'amqp down' }),
      );
    });

    it('records A/B exposure whether or not the send succeeded', async () => {
      templates.render.mockRejectedValue(new Error('x'));
      await engine.process(dto(), 'c-1', 'n-1');
      expect(ab.recordExposure).toHaveBeenCalledTimes(2);
    });
  });

  describe('digests', () => {
    it('holds a notification for a user who chose a DAILY digest: DIGEST_PENDING, bucketed for their morning, nothing sent', async () => {
      routing.route.mockResolvedValue(
        decision({ channels: [], digest: { mode: 'DAILY' } }),
      );
      const r = await engine.process(
        dto({ eventType: 'MKTX-004', priority: 3 }),
        'c-1',
        'n-1',
      );

      expect(state.transition).toHaveBeenLastCalledWith(
        'n-1',
        'DIGEST_PENDING',
        'digest_aggregator',
        expect.objectContaining({ source: 'daily' }),
      );
      expect(buckets.add).toHaveBeenCalledWith(
        'u-1',
        'daily',
        'n-1',
        new Date('2026-09-22T07:00:00.000Z'),
      );
      expect(quiet.nextActiveWindowStart).toHaveBeenCalledWith(
        'Africa/Lagos',
        undefined,
      );
      expect(dispatch.publish).not.toHaveBeenCalled();
      expect(r.channelsTargeted).toEqual([]);
    });

    it('an HOURLY digest is due at the next full hour', async () => {
      routing.route.mockResolvedValue(
        decision({ channels: [], digest: { mode: 'HOURLY' } }),
      );
      await engine.process(
        dto({ eventType: 'MKTX-004', priority: 3 }),
        'c-1',
        'n-1',
      );
      const [, source, , dueAt] = buckets.add.mock.calls[0];
      expect(source).toBe('hourly');
      expect(dueAt.getUTCMinutes()).toBe(0);
      expect(dueAt.getTime()).toBeGreaterThan(Date.now());
      expect(dueAt.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    });

    it('remembers a frequency-capped notification for the "3 or more capped → digest" rule', async () => {
      routing.route.mockResolvedValue(
        decision({
          channels: [],
          suppressedChannels: [
            { channel: 'sms', reason: 'Category hourly cap' },
          ],
        }),
      );
      await engine.process(dto(), 'c-1', 'n-1');
      expect(state.transition).toHaveBeenLastCalledWith(
        'n-1',
        'CAPPED',
        'routing_engine',
        expect.any(Object),
      );
      expect(buckets.add).toHaveBeenCalledWith(
        'u-1',
        'capped',
        'n-1',
        expect.any(Date),
      );
    });

    it('does NOT bucket a notification that was merely missing a template', async () => {
      templates.supportsChannel.mockReturnValue(false);
      await engine.process(dto(), 'c-1', 'n-1');
      expect(buckets.add).not.toHaveBeenCalled();
    });

    it('deferToDigest moves a QUIET notification to DIGEST_PENDING and buckets it under "quiet"', async () => {
      prisma.notification.findUnique.mockResolvedValue({
        status: 'QUIET',
        userId: 'u-1',
      });
      await engine.deferToDigest('n-1');
      expect(quiet.removeFromQueue).toHaveBeenCalledWith('u-1', 'n-1');
      expect(state.transition).toHaveBeenCalledWith(
        'n-1',
        'DIGEST_PENDING',
        'digest_aggregator',
        { source: 'quiet' },
      );
      expect(buckets.add).toHaveBeenCalledWith(
        'u-1',
        'quiet',
        'n-1',
        expect.any(Date),
      );
    });

    it('deferToDigest ignores a notification that is no longer QUIET (already released)', async () => {
      prisma.notification.findUnique.mockResolvedValue({
        status: 'QUEUED',
        userId: 'u-1',
      });
      await engine.deferToDigest('n-1');
      expect(state.transition).not.toHaveBeenCalled();
    });

    it('a DIGEST system notification skips A/B resolution (it has no row in the templates table) and uses DIGEST-v1', async () => {
      prisma.notification.findUnique.mockResolvedValue({
        id: 'd-1',
        status: 'ROUTED',
        userId: 'u-1',
        eventType: 'DIGEST',
        eventId: 'DIGEST-d-1',
        priority: 5,
        personalisationData: { count: 3, items: [] },
        correlationId: 'c',
        classification: 'PROMOTIONAL',
        regulatoryOverride: false,
        user: USER,
      });
      await engine.resume('d-1', ['push', 'in_app']);
      expect(ab.resolveVariant).not.toHaveBeenCalled();
      expect(ab.recordExposure).not.toHaveBeenCalled();
      expect(templates.render).toHaveBeenCalledWith(
        'DIGEST-v1',
        'push',
        expect.any(Object),
      );
    });
  });

  describe('resume (deferred release)', () => {
    const stored = (status: string) => ({
      id: 'n-1',
      status,
      userId: 'u-1',
      eventType: 'TXNX-005',
      eventId: 'E',
      priority: 2,
      personalisationData: { amount: 1 },
      correlationId: 'c',
      classification: 'TRANSACTIONAL',
      regulatoryOverride: false,
      user: USER,
    });

    it('releases a QUIET notification: clears the queue, moves to ROUTED, dispatches', async () => {
      prisma.notification.findUnique.mockResolvedValue(stored('QUIET'));
      await engine.resume('n-1', ['push']);
      expect(quiet.removeFromQueue).toHaveBeenCalledWith('u-1', 'n-1');
      expect(state.transition).toHaveBeenCalledWith(
        'n-1',
        'ROUTED',
        'scheduled_release',
        { channels: ['push'] },
      );
      expect(published()).toEqual(['push']);
    });

    it('releases an STO-deferred (ROUTED) notification without another transition', async () => {
      prisma.notification.findUnique.mockResolvedValue(stored('ROUTED'));
      await engine.resume('n-1', ['sms']);
      expect(state.transition).not.toHaveBeenCalledWith(
        'n-1',
        'ROUTED',
        expect.anything(),
        expect.anything(),
      );
      expect(published()).toEqual(['sms']);
    });

    it('is safe to call twice: an already-dispatched notification is left alone', async () => {
      prisma.notification.findUnique.mockResolvedValue(stored('QUEUED'));
      await engine.resume('n-1', ['sms']);
      expect(dispatch.publish).not.toHaveBeenCalled();
    });

    it('ignores an unknown notification', async () => {
      prisma.notification.findUnique.mockResolvedValue(null);
      await expect(engine.resume('nope', ['sms'])).resolves.toBeUndefined();
    });
  });
});
