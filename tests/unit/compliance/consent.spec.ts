// tests/unit/compliance/consent.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { NotFoundException } from '@nestjs/common';
import { ConsentService } from '../../../src/compliance/dnd/consent.service';
import { ConsentController } from '../../../src/compliance/consent.controller';
import { ComplianceAuditService } from '../../../src/compliance/audit/compliance-audit.service';
import { DeliveryService } from '../../../src/delivery/delivery.service';

describe('ConsentService — policy', () => {
  describe('what needs consent', () => {
    it.each([
      // channel, classification, required
      ['whatsapp', 'TRANSACTIONAL', true], // WhatsApp Business Policy: every message
      ['whatsapp', 'PROMOTIONAL', true],
      ['sms', 'PROMOTIONAL', true],
      ['email', 'PROMOTIONAL', true],
      ['sms', 'TRANSACTIONAL', false], // margin calls, OTPs, confirmations
      ['email', 'TRANSACTIONAL', false],
      ['push', 'PROMOTIONAL', false], // governed by the app's own permission
      ['in_app', 'PROMOTIONAL', false],
    ] as const)('%s %s → required=%s', (channel, cls, required) => {
      expect(ConsentService.requiresConsent(channel, cls)).toBe(required);
    });
  });

  describe('type/channel combinations (WhatsApp needs its OWN opt-in)', () => {
    it('rejects a generic OPT_IN for WhatsApp', () => {
      expect(ConsentService.validateCombination('whatsapp', 'OPT_IN')).toEqual([
        {
          field: 'consent_type',
          error: expect.stringMatching(/WHATSAPP_OPT_IN/),
        },
      ]);
    });
    it('rejects a WHATSAPP_* type on any other channel', () => {
      expect(
        ConsentService.validateCombination('sms', 'WHATSAPP_OPT_IN')[0].error,
      ).toMatch(/only be recorded for the whatsapp channel/);
    });
    it.each([
      ['whatsapp', 'WHATSAPP_OPT_IN'],
      ['whatsapp', 'WHATSAPP_OPT_OUT'],
      ['sms', 'OPT_IN'],
      ['email', 'OPT_OUT'],
    ])('accepts %s + %s', (c, t) => {
      expect(ConsentService.validateCombination(c, t)).toEqual([]);
    });
  });

  describe('with the log', () => {
    const prisma = {
      consentRecord: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const svc = new ConsentService(prisma as never);
    beforeEach(() => jest.resetAllMocks());

    const rec = (over = {}) => ({
      id: 'c-1',
      channel: 'sms',
      consentType: 'OPT_IN',
      granted: true,
      consentText: 'I agree to receive updates',
      ipAddress: '1.2.3.4',
      userAgent: null,
      grantedAt: new Date(),
      ...over,
    });

    it('records the wording, IP and user agent verbatim, and derives `granted` from the type', async () => {
      prisma.consentRecord.create.mockImplementation(async ({ data }: any) => ({
        id: 'c-9',
        grantedAt: new Date(),
        ...data,
      }));
      const out = await svc.record({
        userId: 'u',
        channel: 'sms',
        consentType: 'OPT_OUT',
        consentText: 'Stop sending me offers',
        ipAddress: '197.210.1.1',
        userAgent: 'UA',
      });
      expect(prisma.consentRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          consentText: 'Stop sending me offers',
          ipAddress: '197.210.1.1',
          userAgent: 'UA',
          granted: false,
        }),
      });
      expect(out.granted).toBe(false);
    });

    it('a bad combination is a 422 and writes nothing', async () => {
      await expect(
        svc.record({
          userId: 'u',
          channel: 'whatsapp',
          consentType: 'OPT_IN',
          consentText: 'I agree to receive',
          ipAddress: '1.1.1.1',
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(prisma.consentRecord.create).not.toHaveBeenCalled();
    });

    it('is append-only by construction: the service has no update or delete', () => {
      const methods = Object.getOwnPropertyNames(ConsentService.prototype);
      expect(
        methods.filter((m) => /^(update|delete|remove|revoke|edit)/i.test(m)),
      ).toEqual([]);
    });

    it('the LATEST record decides: an opt-out after an opt-in withdraws consent', async () => {
      prisma.consentRecord.findFirst.mockResolvedValue(
        rec({ granted: false, consentType: 'OPT_OUT' }),
      );
      expect(await svc.hasConsent('u', 'sms')).toBe(false);
      expect(prisma.consentRecord.findFirst.mock.calls[0]![0].orderBy).toEqual({
        grantedAt: 'desc',
      });
    });

    it('no record means no consent', async () => {
      prisma.consentRecord.findFirst.mockResolvedValue(null);
      expect(await svc.hasConsent('u', 'sms')).toBe(false);
    });

    describe('evaluate() — the dispatch decision', () => {
      it('does not even query when consent is not required', async () => {
        const d = await svc.evaluate('u', 'sms', 'TRANSACTIONAL');
        expect(d).toEqual({
          required: false,
          allowed: true,
          reason: 'CONSENT_NOT_REQUIRED',
        });
        expect(prisma.consentRecord.findFirst).not.toHaveBeenCalled();
      });
      it('allows and cites the record when consent is granted', async () => {
        prisma.consentRecord.findFirst.mockResolvedValue(rec());
        expect(await svc.evaluate('u', 'sms', 'PROMOTIONAL')).toEqual({
          required: true,
          allowed: true,
          reason: 'CONSENT_GRANTED',
          consentRecordId: 'c-1',
        });
      });
      it('refuses with NO_CONSENT_RECORD when the user was never asked', async () => {
        prisma.consentRecord.findFirst.mockResolvedValue(null);
        expect(await svc.evaluate('u', 'whatsapp', 'TRANSACTIONAL')).toEqual({
          required: true,
          allowed: false,
          reason: 'NO_CONSENT_RECORD',
        });
      });
      it('refuses with CONSENT_WITHDRAWN and cites the withdrawal', async () => {
        prisma.consentRecord.findFirst.mockResolvedValue(
          rec({ id: 'c-2', granted: false }),
        );
        expect(await svc.evaluate('u', 'email', 'PROMOTIONAL')).toEqual({
          required: true,
          allowed: false,
          reason: 'CONSENT_WITHDRAWN',
          consentRecordId: 'c-2',
        });
      });
    });

    it('statusByChannel lists EVERY channel: granted / withdrawn / none', async () => {
      prisma.consentRecord.findFirst.mockImplementation(
        async ({ where }: any) =>
          where.channel === 'sms'
            ? rec()
            : where.channel === 'email'
              ? rec({
                  id: 'c-3',
                  channel: 'email',
                  granted: false,
                  consentType: 'OPT_OUT',
                })
              : null,
      );
      const out = await svc.statusByChannel('u', ['sms', 'email', 'push']);
      expect(out.map((o) => [o.channel, o.status])).toEqual([
        ['sms', 'granted'],
        ['email', 'withdrawn'],
        ['push', 'none'],
      ]);
      expect(out[2]).toMatchObject({
        consentType: null,
        consentRecordId: null,
        since: null,
      });
    });

    it('history is newest-first, filterable by channel and paginated', async () => {
      prisma.consentRecord.findMany.mockResolvedValue([rec()]);
      prisma.consentRecord.count.mockResolvedValue(1);
      await svc.getConsentHistory('u', 'sms', 20, 10);
      expect(prisma.consentRecord.findMany).toHaveBeenCalledWith({
        where: { userId: 'u', channel: 'sms' },
        orderBy: { grantedAt: 'desc' },
        skip: 20,
        take: 10,
      });
    });
  });
});

describe('ConsentController', () => {
  const consent = {
    record: jest.fn(),
    getConsentHistory: jest.fn(),
    statusByChannel: jest.fn(),
  };
  const prisma = { user: { findUnique: jest.fn() } };
  const c = new ConsentController(consent as never, prisma as never);
  const req = (over = {}) =>
    ({ ip: '10.9.9.9', headers: { 'user-agent': 'req-UA' }, ...over }) as never;
  const body = (over = {}) =>
    ({
      channel: 'sms',
      consentType: 'OPT_IN',
      consentText: 'I agree to receive updates',
      ...over,
    }) as never;
  const U = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: U });
  });

  it('404s an unknown user on every endpoint', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(c.record(U, body(), req())).rejects.toThrow(NotFoundException);
    await expect(c.history(U, { skip: 0, limit: 20, page: 1 })).rejects.toThrow(
      NotFoundException,
    );
    await expect(c.status(U)).rejects.toThrow(NotFoundException);
  });

  it("uses the END USER's IP and user agent from the body when supplied", async () => {
    consent.record.mockResolvedValue({
      id: 'c',
      channel: 'sms',
      consentType: 'OPT_IN',
      granted: true,
      grantedAt: new Date(),
    });
    await c.record(
      U,
      body({ ipAddress: '197.210.10.4', userAgent: 'Android-App' }),
      req(),
    );
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: '197.210.10.4',
        userAgent: 'Android-App',
      }),
    );
  });

  it('falls back to the request IP and User-Agent header', async () => {
    consent.record.mockResolvedValue({
      id: 'c',
      channel: 'sms',
      consentType: 'OPT_IN',
      granted: true,
      grantedAt: new Date(),
    });
    await c.record(U, body(), req());
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '10.9.9.9', userAgent: 'req-UA' }),
    );
  });

  it('answers with the recorded event', async () => {
    const at = new Date();
    consent.record.mockResolvedValue({
      id: 'c-7',
      channel: 'whatsapp',
      consentType: 'WHATSAPP_OPT_IN',
      granted: true,
      grantedAt: at,
    });
    expect(
      await c.record(
        U,
        body({ channel: 'whatsapp', consentType: 'WHATSAPP_OPT_IN' }),
        req(),
      ),
    ).toEqual({
      consentId: 'c-7',
      userId: U,
      channel: 'whatsapp',
      consentType: 'WHATSAPP_OPT_IN',
      granted: true,
      recordedAt: at,
    });
  });

  it('status covers all five channels', async () => {
    consent.statusByChannel.mockResolvedValue([]);
    await c.status(U);
    expect(consent.statusByChannel).toHaveBeenCalledWith(U, [
      'sms',
      'email',
      'push',
      'whatsapp',
      'in_app',
    ]);
  });
});

describe('DeliveryService — consent enforcement at dispatch', () => {
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
    notificationDlqDepth: { set: jest.fn() },
    consentBlocksTotal: { inc: jest.fn() },
    dndViolationsDetected: { inc: jest.fn() },
  };
  const cb = {
    allowRequest: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };
  const retry = { scheduleRetry: jest.fn() };
  const wa = { providerName: 'whatsapp_cloud', send: jest.fn() };
  const noop = { providerName: 'x', send: jest.fn() };
  const dispatch = { lookupContact: jest.fn() };
  const consent = { evaluate: jest.fn() };
  const config = { get: jest.fn() };
  const dnd = { check: jest.fn() };

  const build = () =>
    new DeliveryService(
      prisma,
      prometheus as never,
      cb as never,
      retry as never,
      noop as never,
      noop as never,
      noop as never,
      noop as never,
      wa as never,
      noop as never,
      dnd as never,
      dispatch as never,
      noop as never,
      consent as never,
      config as never,
    );
  const msg = {
    notificationId: 'n-1',
    userId: 'u-1',
    channel: 'whatsapp',
    recipient: 'user:u-1',
    body: 'hi',
    priority: 3,
    correlationId: 'c',
  };
  const stateOf = (call: any[]) => call[0]?.data?.status;

  beforeEach(() => {
    jest.resetAllMocks();
    cb.allowRequest.mockResolvedValue(true);
    prisma.notification.findUnique.mockResolvedValue({
      status: 'QUEUED',
      eventType: 'MKTX-004',
      classification: 'PROMOTIONAL',
    });
    prisma.notification.update.mockResolvedValue({
      deliveryAttempts: 1,
      createdAt: new Date(),
    });
    prisma.deadLetterQueue.count.mockResolvedValue(0);
    dispatch.lookupContact.mockResolvedValue({
      recipient: '+2348031234567',
      market: 'NG',
    });
    wa.send.mockResolvedValue({
      success: true,
      provider: 'whatsapp_cloud',
      externalId: 'w',
      latencyMs: 1,
    });
    config.get.mockReturnValue(undefined); // default = enforce
  });

  const noConsent = {
    required: true,
    allowed: false,
    reason: 'NO_CONSENT_RECORD',
  };

  it('ENFORCE (default): stops a WhatsApp send with no consent — state NO_CONSENT, provider never called', async () => {
    consent.evaluate.mockResolvedValue(noConsent);
    await build().process(msg);
    expect(wa.send).not.toHaveBeenCalled();
    expect(prisma.notification.update.mock.calls.map(stateOf)).toContain(
      'NO_CONSENT',
    );
    expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'QUEUED',
        toStatus: 'NO_CONSENT',
        actor: 'consent_service',
        metadata: expect.objectContaining({ reason: 'NO_CONSENT_RECORD' }),
      }),
    });
    expect(prometheus.consentBlocksTotal.inc).toHaveBeenCalledWith({
      channel: 'whatsapp',
      classification: 'PROMOTIONAL',
      reason: 'NO_CONSENT_RECORD',
      mode: 'enforce',
    });
  });

  it('a WITHDRAWN consent blocks the very next send', async () => {
    consent.evaluate.mockResolvedValue({
      required: true,
      allowed: false,
      reason: 'CONSENT_WITHDRAWN',
      consentRecordId: 'c-2',
    });
    await build().process(msg);
    expect(wa.send).not.toHaveBeenCalled();
    expect(prisma.notificationStateLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: { reason: 'CONSENT_WITHDRAWN', consentRecordId: 'c-2' },
      }),
    });
  });

  it('a granted consent lets the send through AND stores the authorising record on the notification', async () => {
    consent.evaluate.mockResolvedValue({
      required: true,
      allowed: true,
      reason: 'CONSENT_GRANTED',
      consentRecordId: 'c-1',
    });
    await build().process(msg);
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: { consentRecordId: 'c-1' },
    });
    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it('does not touch the notification for sends that need no consent', async () => {
    consent.evaluate.mockResolvedValue({
      required: false,
      allowed: true,
      reason: 'CONSENT_NOT_REQUIRED',
    });
    await build().process(msg);
    expect(
      prisma.notification.update.mock.calls.some(
        (c: any[]) => 'consentRecordId' in (c[0].data ?? {}),
      ),
    ).toBe(false);
    expect(wa.send).toHaveBeenCalled();
  });

  it('AUDIT mode: sends anyway, but counts and logs the violation (for migrating existing users)', async () => {
    config.get.mockReturnValue('audit');
    consent.evaluate.mockResolvedValue(noConsent);
    await build().process(msg);
    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(prometheus.consentBlocksTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'audit' }),
    );
    expect(prisma.notification.update.mock.calls.map(stateOf)).not.toContain(
      'NO_CONSENT',
    );
  });

  it('OFF mode: does not even look consent up', async () => {
    config.get.mockReturnValue('off');
    await build().process(msg);
    expect(consent.evaluate).not.toHaveBeenCalled();
    expect(wa.send).toHaveBeenCalled();
  });

  it('fails CLOSED but keeps the message when the consent lookup errors: retry, never send', async () => {
    consent.evaluate.mockRejectedValue(new Error('db down'));
    prisma.notification.findUnique.mockResolvedValueOnce({
      status: 'QUEUED',
      eventType: 'MKTX-004',
      classification: 'PROMOTIONAL',
    });
    prisma.notification.findUnique.mockResolvedValueOnce({
      deliveryAttempts: 0,
      priority: 3,
    });
    retry.scheduleRetry.mockResolvedValue(true);
    await build().process(msg);
    expect(wa.send).not.toHaveBeenCalled();
    expect(retry.scheduleRetry).toHaveBeenCalled();
  });

  it('a NO_CONSENT notification is terminal: a redelivered message is ignored', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      status: 'NO_CONSENT',
      eventType: 'MKTX-004',
      classification: 'PROMOTIONAL',
    });
    await build().process(msg);
    expect(consent.evaluate).not.toHaveBeenCalled();
    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe('ComplianceAuditService (challenge B2.3)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    notification: { findMany: jest.fn(), count: jest.fn() },
    consentRecord: { findMany: jest.fn() },
  };
  const svc = new ComplianceAuditService(prisma);
  beforeEach(() => jest.resetAllMocks());

  describe('window', () => {
    it('defaults to the last 90 days', () => {
      const w = svc.window();
      expect(Math.round((w.to.getTime() - w.from.getTime()) / 86_400_000)).toBe(
        90,
      );
    });
    it('rejects an inverted window and one longer than 90 days with a 422 field error', () => {
      expect(() =>
        svc.window('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ).toThrow(expect.objectContaining({ status: 422 }));
      let details: Array<{ field: string; error: string }> = [];
      try {
        svc.window('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z');
      } catch (e) {
        details = (e as { response: { details: typeof details } }).response
          .details;
      }
      expect(details[0]).toMatchObject({
        field: 'from',
        error: expect.stringMatching(/90 days/),
      });
    });
  });

  it('SMS audit: rows carry the DND proof, and the headline finding (sent without a DND check) is counted', async () => {
    const created = new Date('2026-09-01T10:00:00Z');
    prisma.notification.findMany.mockResolvedValue([
      {
        id: 'n',
        userId: 'u',
        eventType: 'RISK-001',
        classification: 'TRANSACTIONAL',
        status: 'DELIVERED',
        provider: 'termii',
        createdAt: created,
        deliveredAt: new Date(created.getTime() + 4379),
        dndChecked: true,
        dndCheckTimestamp: created,
        dndResult: 'REGISTERED',
        regulatoryOverride: true,
        consentRecordId: null,
      },
    ]);
    prisma.notification.count
      .mockResolvedValueOnce(120)
      .mockResolvedValueOnce(0);

    const r: any = await svc.smsAudit({ skip: 0, limit: 20 });

    expect(r.summary).toEqual({ totalSms: 120, sentWithoutDndCheck: 0 });
    expect(r.data[0]).toMatchObject({
      dndChecked: true,
      dndResult: 'REGISTERED',
      latencyMs: 4379,
    });
    const unchecked = prisma.notification.count.mock.calls[1][0].where;
    expect(unchecked).toMatchObject({
      channel: 'sms',
      dndChecked: false,
      status: { in: expect.arrayContaining(['SENT', 'DELIVERED']) },
    });
  });

  it('promotional-consent audit: joins each message to the consent record that authorised it', async () => {
    prisma.notification.findMany.mockResolvedValue([
      {
        id: 'n1',
        userId: 'u',
        eventType: 'MKTX-004',
        channel: 'whatsapp',
        status: 'SENT',
        createdAt: new Date(),
        consentRecordId: 'c-1',
      },
      {
        id: 'n2',
        userId: 'u2',
        eventType: 'MKTX-004',
        channel: 'sms',
        status: 'SENT',
        createdAt: new Date(),
        consentRecordId: null,
      },
    ]);
    prisma.notification.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    prisma.consentRecord.findMany.mockResolvedValue([
      {
        id: 'c-1',
        consentType: 'WHATSAPP_OPT_IN',
        granted: true,
        consentText: 'I agree',
        ipAddress: '1.2.3.4',
        grantedAt: new Date('2026-08-01'),
      },
    ]);

    const r: any = await svc.promotionalConsentAudit({ skip: 0, limit: 20 });

    expect(r.summary).toEqual({
      totalPromotional: 2,
      withConsent: 1,
      withoutConsent: 1,
    });
    expect(r.data[0]).toMatchObject({
      consentMissing: false,
      consent: {
        recordId: 'c-1',
        consentText: 'I agree',
        ipAddress: '1.2.3.4',
      },
    });
    expect(r.data[1]).toMatchObject({ consentMissing: true });
    expect(r.data[1].consent).toBeUndefined();
    expect(prisma.notification.findMany.mock.calls[0][0].where).toMatchObject({
      classification: 'PROMOTIONAL',
      channel: { in: ['sms', 'email', 'whatsapp'] },
    });
  });

  it('does not query consent records when there are no rows', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);
    await svc.promotionalConsentAudit({ skip: 0, limit: 20 });
    expect(prisma.consentRecord.findMany).not.toHaveBeenCalled();
  });
});
