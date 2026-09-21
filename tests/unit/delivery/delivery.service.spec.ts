// tests/unit/delivery/delivery.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { DeliveryService } from '../../../src/delivery/delivery.service';
import { PreparedNotification } from '../../../src/delivery/providers/delivery-provider.interface';
import { DndResult } from '../../../src/compliance/dnd/dnd.service';

const NOTIFICATION_ID = 'n-1';

const smsMessage = (): PreparedNotification => ({
  notificationId: NOTIFICATION_ID,
  userId: 'u-1',
  channel: 'sms',
  recipient: 'user:u-1', // queue carries a reference, never the address
  body: 'hello',
  priority: 2,
  correlationId: 'c-1',
});

const dndResult = (over: Partial<DndResult>): DndResult => ({
  allowed: true,
  reason: 'NOT_DND_REGISTERED',
  classification: 'PROMOTIONAL',
  registryStatus: 'NOT_REGISTERED',
  checkedAt: '2026-01-01T10:00:00.000Z',
  regulatoryOverride: false,
  registryUnavailable: false,
  ...over,
});

describe('DeliveryService.process', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    notification: { findUnique: jest.fn(), update: jest.fn() },
    notificationStateLog: { create: jest.fn() },
    deliveryAttempt: { create: jest.fn() },
    deadLetterQueue: { create: jest.fn(), count: jest.fn() },
  };
  const prometheus = {
    recordDelivery: jest.fn(),
    recordDeliveryLatency: jest.fn(),
    dndViolationsDetected: { inc: jest.fn() },
    notificationDlqDepth: { set: jest.fn() },
  };
  const circuitBreaker = {
    allowRequest: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };
  const retryWorker = { scheduleRetry: jest.fn() };
  const msg91 = { providerName: 'msg91', send: jest.fn() };
  const twilio = { providerName: 'twilio', send: jest.fn() };
  const nodemailer = { providerName: 'nodemailer', send: jest.fn() };
  const noop = { providerName: 'noop', send: jest.fn() };
  const dnd = { check: jest.fn() };
  const dispatch = { lookupContact: jest.fn() };
  const consent = { evaluate: jest.fn() };
  const config = { get: jest.fn() };
  const termii = { providerName: 'termii', send: jest.fn() };

  let service: DeliveryService;

  const record = (status: string, eventType = 'MKTX-001') =>
    prisma.notification.findUnique.mockResolvedValueOnce({ status, eventType });

  beforeEach(() => {
    jest.resetAllMocks();
    circuitBreaker.allowRequest.mockResolvedValue(true);
    prisma.notification.update.mockResolvedValue({ deliveryAttempts: 1 });
    prisma.deadLetterQueue.count.mockResolvedValue(0);
    dispatch.lookupContact.mockResolvedValue({
      recipient: '+919876543210',
      market: 'IN',
    });
    consent.evaluate.mockResolvedValue({
      required: false,
      allowed: true,
      reason: 'CONSENT_NOT_REQUIRED',
    });
    config.get.mockReturnValue(undefined);
    msg91.send.mockResolvedValue({
      success: true,
      provider: 'msg91',
      externalId: 'ext-1',
      latencyMs: 5,
    });

    service = new DeliveryService(
      prisma,
      prometheus as never,
      circuitBreaker as never,
      retryWorker as never,
      msg91 as never,
      twilio as never,
      nodemailer as never,
      noop as never,
      noop as never,
      noop as never,
      dnd as never,
      dispatch as never,
      termii as never,
      consent as never,
      config as never,
    );
  });

  it('drops a message for an unknown notification without calling a provider', async () => {
    prisma.notification.findUnique.mockResolvedValueOnce(null);
    await service.process(smsMessage());
    expect(msg91.send).not.toHaveBeenCalled();
    expect(dnd.check).not.toHaveBeenCalled();
  });

  it.each(['SENT', 'DELIVERED', 'READ', 'DND', 'DLQ', 'BOUNCED'])(
    'ignores a redelivered message for a notification already %s (no double send)',
    async (status) => {
      record(status);
      await service.process(smsMessage());
      expect(msg91.send).not.toHaveBeenCalled();
      expect(dnd.check).not.toHaveBeenCalled();
    },
  );

  it('checks DND at dispatch and persists the audit record before sending', async () => {
    record('QUEUED');
    dnd.check.mockResolvedValue(dndResult({}));

    await service.process(smsMessage());

    expect(dnd.check).toHaveBeenCalledWith(
      'u-1',
      '+919876543210',
      'MKTX-001',
      'sms',
    );
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID },
      data: expect.objectContaining({
        dndChecked: true,
        dndCheckTimestamp: new Date('2026-01-01T10:00:00.000Z'),
        dndResult: 'NOT_REGISTERED',
        classification: 'PROMOTIONAL',
      }),
    });
    expect(msg91.send).toHaveBeenCalledTimes(1);

    // audit write happens strictly before the provider call
    const auditOrder = prisma.notification.update.mock.invocationCallOrder[0];
    const sendOrder = msg91.send.mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(sendOrder);
  });

  it('blocks a DND-registered promotional SMS: state DND, no provider call', async () => {
    record('QUEUED');
    dnd.check.mockResolvedValue(
      dndResult({
        allowed: false,
        reason: 'DND_REGISTERED_PROMOTIONAL_BLOCKED',
        registryStatus: 'REGISTERED',
      }),
    );

    await service.process(smsMessage());

    expect(msg91.send).not.toHaveBeenCalled();
    expect(twilio.send).not.toHaveBeenCalled();
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DND' }),
      }),
    );
    expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'QUEUED',
        toStatus: 'DND',
        actor: 'dnd_service',
      }),
    });
  });

  it('records the regulatory override when a CRITICAL SMS goes to a registered user', async () => {
    record('QUEUED', 'RISK-001');
    dnd.check.mockResolvedValue(
      dndResult({
        reason: 'CRITICAL_EVENT_BYPASS',
        classification: 'TRANSACTIONAL',
        registryStatus: 'REGISTERED',
        regulatoryOverride: true,
      }),
    );

    await service.process(smsMessage());

    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID },
      data: expect.objectContaining({
        dndResult: 'REGISTERED',
        regulatoryOverride: true,
      }),
    });
    expect(msg91.send).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the registry is down: schedules a retry instead of sending', async () => {
    record('QUEUED');
    prisma.notification.findUnique.mockResolvedValueOnce({
      deliveryAttempts: 0,
      priority: 2,
    });
    retryWorker.scheduleRetry.mockResolvedValue(true);
    dnd.check.mockResolvedValue(
      dndResult({
        allowed: false,
        reason: 'DND_CHECK_UNAVAILABLE',
        registryStatus: 'UNKNOWN',
        registryUnavailable: true,
      }),
    );

    await service.process(smsMessage());

    expect(msg91.send).not.toHaveBeenCalled();
    expect(retryWorker.scheduleRetry).toHaveBeenCalledWith(
      NOTIFICATION_ID,
      1,
      2,
    );
  });

  it('does not run the DND check for non-SMS channels', async () => {
    record('QUEUED');
    nodemailer.send.mockResolvedValue({
      success: true,
      provider: 'nodemailer',
      externalId: 'm-1',
      latencyMs: 3,
    });

    dispatch.lookupContact.mockResolvedValue({
      recipient: 'a@b.co',
      market: 'IN',
    });
    await service.process({
      ...smsMessage(),
      channel: 'email',
      recipient: 'user:u-1',
    });

    expect(dnd.check).not.toHaveBeenCalled();
    expect(nodemailer.send).toHaveBeenCalledTimes(1);
  });

  it('moves a RETRYING notification back to QUEUED before re-sending', async () => {
    record('RETRYING');
    dnd.check.mockResolvedValue(dndResult({}));

    await service.process(smsMessage());

    expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'RETRYING',
        toStatus: 'QUEUED',
        actor: 'retry_worker',
      }),
    });
  });

  it('sends Nigerian-market SMS via Termii, not MSG91', async () => {
    record('QUEUED');
    dispatch.lookupContact.mockResolvedValue({
      recipient: '+2348031234567',
      market: 'NG',
    });
    dnd.check.mockResolvedValue(dndResult({}));
    termii.send.mockResolvedValue({
      success: true,
      provider: 'termii',
      externalId: 'tm-1',
      latencyMs: 4,
    });

    await service.process(smsMessage());

    expect(termii.send).toHaveBeenCalledTimes(1);
    expect(msg91.send).not.toHaveBeenCalled();
  });

  it('fails Nigerian SMS over from Termii to Twilio', async () => {
    record('QUEUED');
    dispatch.lookupContact.mockResolvedValue({
      recipient: '+2348031234567',
      market: 'NG',
    });
    dnd.check.mockResolvedValue(dndResult({}));
    termii.send.mockResolvedValue({
      success: false,
      provider: 'termii',
      latencyMs: 1,
      errorCode: '503',
    });
    twilio.send.mockResolvedValue({
      success: true,
      provider: 'twilio',
      externalId: 't-2',
      latencyMs: 3,
    });

    await service.process(smsMessage());

    expect(twilio.send).toHaveBeenCalledTimes(1);
    expect(msg91.send).not.toHaveBeenCalled();
  });

  it('passes the message classification to the provider (Termii route selection)', async () => {
    prisma.notification.findUnique.mockResolvedValueOnce({
      status: 'QUEUED',
      eventType: 'RISK-001',
      classification: 'TRANSACTIONAL',
    });
    dnd.check.mockResolvedValue(dndResult({ classification: 'TRANSACTIONAL' }));

    await service.process(smsMessage());

    expect(msg91.send).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'TRANSACTIONAL' }),
    );
  });

  describe('DND violation tripwire', () => {
    it('refuses to send, and counts a violation, if the policy ever allows a promo SMS to a registered number', async () => {
      record('QUEUED');
      dnd.check.mockResolvedValue(
        dndResult({
          allowed: true,
          classification: 'PROMOTIONAL',
          registryStatus: 'REGISTERED',
        }),
      );

      await service.process(smsMessage());

      expect(prometheus.dndViolationsDetected.inc).toHaveBeenCalledWith({
        channel: 'sms',
        classification: 'PROMOTIONAL',
      });
      expect(msg91.send).not.toHaveBeenCalled();
      expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          toStatus: 'DND',
          metadata: expect.objectContaining({ reason: 'DND_POLICY_TRIPWIRE' }),
        }),
      });
    });

    it('does not trip for a legitimate transactional send to a registered number', async () => {
      record('QUEUED');
      dnd.check.mockResolvedValue(
        dndResult({
          classification: 'TRANSACTIONAL',
          registryStatus: 'REGISTERED',
          reason: 'TRANSACTIONAL_EXEMPT',
        }),
      );
      await service.process(smsMessage());
      expect(prometheus.dndViolationsDetected.inc).not.toHaveBeenCalled();
      expect(msg91.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('delivery receipts', () => {
    const arrange = (receipt?: 'simulated' | 'immediate') => {
      record('QUEUED');
      dnd.check.mockResolvedValue(dndResult({}));
      prisma.notification.update.mockResolvedValue({
        deliveryAttempts: 1,
        createdAt: new Date(Date.now() - 2000),
      });
      msg91.send.mockResolvedValue({
        success: true,
        provider: 'msg91',
        externalId: 'e',
        latencyMs: 1,
        ...(receipt && { receipt }),
      });
    };

    it('leaves a real provider send at SENT — the DLR webhook confirms it later', async () => {
      arrange();
      await service.process(smsMessage());
      const statuses = prisma.notification.update.mock.calls.map(
        (c: any) => c[0].data.status,
      );
      expect(statuses).not.toContain('DELIVERED');
      expect(prometheus.recordDeliveryLatency).not.toHaveBeenCalled();
    });

    it('confirms a mock-mode send as DELIVERED, labelled simulated in the state log', async () => {
      arrange('simulated');
      await service.process(smsMessage());
      expect(prisma.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'DELIVERED',
            deliveredAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromStatus: 'SENT',
          toStatus: 'DELIVERED',
          actor: 'msg91_mock_dlr',
          metadata: { simulated: true },
        }),
      });
      expect(prometheus.recordDeliveryLatency).toHaveBeenCalledWith(
        'sms',
        expect.any(Number),
      );
    });

    it('an in-app store write is a real, non-simulated delivery', async () => {
      arrange('immediate');
      await service.process(smsMessage());
      expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor: 'msg91_store',
          metadata: { simulated: false },
        }),
      });
    });
  });

  it('fails over to the secondary SMS provider when the primary fails', async () => {
    record('QUEUED');
    dnd.check.mockResolvedValue(dndResult({}));
    msg91.send.mockResolvedValue({
      success: false,
      provider: 'msg91',
      latencyMs: 1,
      errorCode: '503',
    });
    twilio.send.mockResolvedValue({
      success: true,
      provider: 'twilio',
      externalId: 't-1',
      latencyMs: 4,
    });

    await service.process(smsMessage());

    expect(twilio.send).toHaveBeenCalledTimes(1);
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', provider: 'twilio' }),
      }),
    );
  });
});

describe('DeliveryService.deadLetter', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    notification: { findUnique: jest.fn(), update: jest.fn() },
    notificationStateLog: { create: jest.fn() },
    deadLetterQueue: { create: jest.fn(), count: jest.fn() },
  };
  const prometheus = { notificationDlqDepth: { set: jest.fn() } };

  it('persists the failure, logs the transition and updates the depth gauge', async () => {
    jest.resetAllMocks();
    prisma.notification.findUnique.mockResolvedValue({ status: 'ROUTED' });
    prisma.deadLetterQueue.count.mockResolvedValue(7);
    const noop = {} as never;
    const service = new DeliveryService(
      prisma,
      prometheus as never,
      ...(Array(13).fill(noop) as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    );

    await service.deadLetter('n-9', { a: 1 }, { message: 'boom', code: 'X' });

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DLQ', failedReason: 'boom' }),
      }),
    );
    expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: 'ROUTED', toStatus: 'DLQ' }),
    });
    expect(prisma.deadLetterQueue.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ notificationId: 'n-9', lastError: 'X' }),
    });
    expect(prometheus.notificationDlqDepth.set).toHaveBeenCalledWith(7);
  });

  it('never stores a phone/email address in the DLQ payload', async () => {
    jest.resetAllMocks();
    prisma.notification.findUnique.mockResolvedValue({ status: 'QUEUED' });
    prisma.deadLetterQueue.count.mockResolvedValue(1);
    const noop = {} as never;
    const service = new DeliveryService(
      prisma,
      prometheus as never,
      ...(Array(13).fill(noop) as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    );

    await service.deadLetter(
      'n-10',
      { channel: 'sms', recipient: '+2348012345678', body: 'x' },
      { message: 'boom', code: 'X' },
    );

    const stored =
      prisma.deadLetterQueue.create.mock.calls[0][0].data.originalEvent;
    expect(stored.recipient).toBe('[redacted]');
    expect(JSON.stringify(stored)).not.toContain('+2348012345678');
  });
});
