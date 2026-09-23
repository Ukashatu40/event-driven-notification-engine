// tests/e2e/pipeline.e2e-spec.ts
//
// End-to-end: the REAL app (all modules, Kafka, RabbitMQ, Postgres, Redis)
// driven over HTTP exactly as an API consumer would — including the literal
// request bodies from spec Appendix A.
import { rawPool } from '../helpers/infra';
import { createHmac, randomUUID } from 'crypto';

// Credentials for the three roles + a payment provider secret. Set BEFORE the
// app module is compiled: configuration is read when ConfigModule initialises.
const KEYS = {
  SERVICE: 'e2e-service-key-1',
  OPERATOR: 'e2e-operator-key-2',
  ADMIN: 'e2e-admin-key-3',
};
process.env.SERVICE_API_KEY = KEYS.SERVICE;
process.env.OPERATOR_API_KEY = KEYS.OPERATOR;
process.env.ADMIN_API_KEY = KEYS.ADMIN;
process.env.PAYSTACK_SECRET_KEY = 'sk_e2e_secret';

import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { PiiService } from '../../src/shared/pii/pii.service';
import { DigestFlushService } from '../../src/notifications/digest/digest-flush.service';

const suite = process.env.INFRA_UP === 'true' ? describe : describe.skip;

suite('notification pipeline (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const users: string[] = [];
  const tokens: Record<string, string> = {};

  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    opts: {
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        'content-type': 'application/json',
        ...(opts.token && { authorization: `Bearer ${opts.token}` }),
        ...opts.headers,
      },
      payload:
        opts.body === undefined
          ? undefined
          : typeof opts.body === 'string'
            ? opts.body
            : JSON.stringify(opts.body),
    });
    let json: any;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, body: json, headers: res.headers };
  };

  const login = async (role: 'SERVICE' | 'OPERATOR' | 'ADMIN') =>
    (
      await call('POST', '/api/v1/auth/login', {
        body: { serviceKey: KEYS[role], role },
      })
    ).body.access_token as string;

  const createUser = async (
    over: {
      dnd?: 'REGISTERED' | 'NOT_REGISTERED';
      language?: any;
      market?: 'IN' | 'NG';
      consent?: boolean;
    } = {},
  ) => {
    const pii = app.get(PiiService);
    const n = Math.floor(Math.random() * 1e9);
    const phone = `+2348${String(n).padStart(9, '0')}`;
    const email = `e2e.${randomUUID()}@e2e.test`;
    const user = await prisma.user.create({
      data: {
        name: 'E2E User',
        ...pii.protectContact({ phone, email }),
        language: over.language ?? 'EN',
        market: over.market ?? 'NG',
        timezone: 'Africa/Lagos',
        dndStatus: over.dnd ?? 'NOT_REGISTERED',
        quietHoursStart: '00:00',
        quietHoursEnd: '00:01',
      } as any,
    });
    users.push(user.id);
    // Like a seeded user: every channel enabled for every category. (A user with
    // no rows gets only the system defaults, e.g. no SMS for market events.)
    await prisma.userPreference.createMany({
      data: ['TXNX', 'RISK', 'SIPX', 'MKTX', 'REGX'].flatMap((eventCategory) =>
        ['sms', 'email', 'push', 'whatsapp', 'in_app'].map((channel) => ({
          userId: user.id,
          eventCategory,
          channel,
          enabled: true,
          digestMode: 'IMMEDIATE' as const,
        })),
      ),
    });
    if (over.consent !== false) {
      // Consent goes in through the real API, like it would in production.
      for (const [channel, consentType] of [
        ['sms', 'OPT_IN'],
        ['email', 'OPT_IN'],
        ['whatsapp', 'WHATSAPP_OPT_IN'],
      ] as const) {
        const r = await call('POST', `/api/v1/users/${user.id}/consents`, {
          token: tokens.SERVICE,
          body: {
            channel,
            consent_type: consentType,
            consent_text: 'E2E: I agree to receive notifications.',
            ip_address: '197.210.10.4',
          },
        });
        if (r.status !== 201)
          throw new Error(
            `consent setup failed: ${r.status} ${JSON.stringify(r.body)}`,
          );
      }
    }
    return { id: user.id, email };
  };

  /** Poll until `fn` returns something truthy — the pipeline is asynchronous. */
  const eventually = async <T>(
    fn: () => Promise<T | undefined | false>,
    ms = 20_000,
  ): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end)
        throw new Error('timed out waiting for the pipeline');
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const future = (h = 2) => new Date(Date.now() + h * 3_600_000).toISOString();
  const marginCall = (userId: string, over: object = {}) => ({
    event_type: 'RISK-001',
    event_id: `EVT-E2E-${randomUUID()}`,
    source_system: 'margin_engine',
    timestamp: new Date().toISOString(),
    priority: 1,
    user_id: userId,
    payload: {
      shortfall_amount: 125000.0,
      current_margin: 375000.0,
      required_margin: 500000.0,
      deadline: future(1),
      affected_positions: [
        { symbol: 'RELIANCE', qty: 500, current_value: 620000.0 },
      ],
      auto_square_off_time: future(2),
    },
    idempotency_key: `e2e-${randomUUID()}`,
    ...over,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
      { rawBody: true },
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    for (const r of ['SERVICE', 'OPERATOR', 'ADMIN'] as const)
      tokens[r] = await login(r);
  }, 90_000);

  afterAll(async () => {
    if (users.length) {
      const ids = users.map((u) => `'${u}'`).join(',');
      await prisma.$executeRawUnsafe(
        `DELETE FROM notification_state_log WHERE "notificationId" IN (SELECT id FROM notifications WHERE "userId" IN (${ids}))`,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM delivery_attempts WHERE "notificationId" IN (SELECT id FROM notifications WHERE "userId" IN (${ids}))`,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM dead_letter_queue WHERE "notificationId" IN (SELECT id FROM notifications WHERE "userId" IN (${ids}))`,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM notifications WHERE "userId" IN (${ids})`,
      );
      // consent_records is append-only (a trigger refuses DELETE), so test data is
      // purged the way a DBA would: on ONE dedicated connection, with triggers
      // disabled for that transaction only (superuser-only replica role).
      const pool = rawPool();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(
          'DELETE FROM consent_records WHERE "userId" = ANY($1::uuid[])',
          [users],
        );
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
        await pool.end();
      }
      await prisma.$executeRawUnsafe(
        `DELETE FROM user_preferences WHERE "userId" IN (${ids})`,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id IN (${ids})`);
    }
    await app.close();
  });

  describe('authentication and RBAC', () => {
    it('a SERVICE key cannot mint an ADMIN token', async () => {
      const r = await call('POST', '/api/v1/auth/login', {
        body: { serviceKey: KEYS.SERVICE, role: 'ADMIN' },
      });
      expect(r.status).toBe(401);
    });

    it('rejects requests with no token', async () => {
      expect((await call('POST', '/api/v1/events', { body: {} })).status).toBe(
        401,
      );
    });

    it('enforces the role matrix on real routes', async () => {
      const u = await createUser();
      expect(
        (
          await call('POST', '/api/v1/events', {
            token: tokens.OPERATOR,
            body: marginCall(u.id),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('GET', '/api/v1/analytics/delivery-rates', {
            token: tokens.SERVICE,
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('GET', '/api/v1/dlq', { token: tokens.OPERATOR })).status,
      ).toBe(200);
      expect(
        (
          await call('PATCH', `/api/v1/dlq/${randomUUID()}/resolve`, {
            token: tokens.OPERATOR,
            body: { action: 'discard' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            'GET',
            '/api/v1/analytics/delivery-rates?period=7d&channel=all',
            { token: tokens.OPERATOR },
          )
        ).status,
      ).toBe(200);
    });

    it('refresh tokens are single-use: replay revokes the session', async () => {
      const first = (
        await call('POST', '/api/v1/auth/login', {
          body: { serviceKey: KEYS.SERVICE, role: 'SERVICE' },
        })
      ).body;
      expect(
        (
          await call('POST', '/api/v1/auth/refresh', {
            body: { refreshToken: first.refresh_token },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call('POST', '/api/v1/auth/refresh', {
            body: { refreshToken: first.refresh_token },
          })
        ).status,
      ).toBe(401);
    });
  });

  describe('POST /api/v1/events — spec Appendix A contract', () => {
    it('accepts the spec request (snake_case) and answers 202 with the documented body', async () => {
      const u = await createUser({ dnd: 'REGISTERED' });
      const r = await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: marginCall(u.id),
      });
      expect(r.status).toBe(202);
      expect(Object.keys(r.body).sort()).toEqual([
        'channels_targeted',
        'created_at',
        'estimated_delivery_ms',
        'event_id',
        'notification_id',
        'status',
      ]);
      expect(r.body.status).toBe('CREATED');
      expect(r.body.channels_targeted).toEqual(
        expect.arrayContaining(['sms', 'push']),
      );
      expect(r.body).not.toHaveProperty('success'); // no envelope
    });

    it('returns the spec 422 VALIDATION_FAILED with field-level details', async () => {
      const u = await createUser();
      const bad = marginCall(u.id, {
        payload: {
          shortfall_amount: -1,
          current_margin: 1,
          required_margin: 2,
          deadline: '2020-01-01T00:00:00.000Z',
          auto_square_off_time: future(),
        },
      });
      const r = await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: bad,
      });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({
        error: 'VALIDATION_FAILED',
        message: 'Event payload validation failed',
      });
      expect(r.body.details).toEqual(
        expect.arrayContaining([
          {
            field: 'payload.shortfall_amount',
            error: 'must be a positive number',
          },
          { field: 'payload.deadline', error: 'must be a future timestamp' },
        ]),
      );
      expect(r.body.request_id).toEqual(expect.any(String));
    });

    it('rejects unknown top-level fields (no silent stripping)', async () => {
      const u = await createUser();
      const r = await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: { ...marginCall(u.id), surprise: true },
      });
      expect(r.status).toBe(422);
    });

    it('404s an unknown user', async () => {
      const r = await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: marginCall(randomUUID()),
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('NOT_FOUND');
    });

    it('is idempotent: the same idempotency_key returns the ORIGINAL notification id', async () => {
      const u = await createUser();
      const body = marginCall(u.id);
      const a = await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body,
      });
      const b = await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: { ...body, event_id: `${body.event_id}-retry` },
      });
      expect(b.body.notification_id).toBe(a.body.notification_id);
    });
  });

  describe('margin call to a DND-registered user (spec Question 2)', () => {
    it('flows Kafka → engine → RabbitMQ → worker → delivered, with the full compliance record', async () => {
      const u = await createUser({ dnd: 'REGISTERED' });
      const accepted = await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: marginCall(u.id),
      });
      const id = accepted.body.notification_id as string;

      const n = await eventually(async () => {
        const r = await call('GET', `/api/v1/notifications/${id}`, {
          token: tokens.SERVICE,
        });
        return r.status === 200 && ['SENT', 'DELIVERED'].includes(r.body.status)
          ? r.body
          : false;
      });

      expect(n.channel).toBe('sms');
      expect(n.state_history.map((h: any) => h.status)).toEqual(
        expect.arrayContaining([
          'CREATED',
          'ENRICHED',
          'ROUTED',
          'QUEUED',
          'SENT',
        ]),
      );
      expect(n.state_history[0]).toMatchObject({
        status: 'CREATED',
        actor: 'event_ingestion',
      });
      expect(n.compliance).toMatchObject({
        dnd_checked: true,
        dnd_result: 'REGISTERED',
        classification: 'TRANSACTIONAL',
        regulatory_override: true,
        frequency_cap_checked: true,
        frequency_cap_result: 'WITHIN_LIMITS',
      });
      expect(
        new Date(n.compliance.dnd_check_timestamp).getTime(),
      ).toBeGreaterThan(new Date(n.state_history[0].timestamp).getTime());
      expect(n.cost_paisa).toBeGreaterThanOrEqual(0);
    });

    it('one row per channel, each with its own history', async () => {
      const u = await createUser({ dnd: 'REGISTERED' });
      await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: marginCall(u.id),
      });
      const rows = await eventually(async () => {
        const r = await prisma.notification.findMany({
          where: { userId: u.id },
          select: { channel: true, status: true },
        });
        return r.length >= 5 &&
          r.every((x) => x.status !== 'QUEUED' && x.status !== 'ROUTED')
          ? r
          : false;
      });
      expect(rows.map((r) => r.channel).sort()).toEqual([
        'email',
        'in_app',
        'push',
        'sms',
        'whatsapp',
      ]);
    });
  });

  describe('DND at dispatch', () => {
    it('blocks a PROMOTIONAL SMS to a DND-registered user, while their other channels are delivered', async () => {
      const u = await createUser({ dnd: 'REGISTERED' });
      const promo = {
        ...marginCall(u.id),
        event_type: 'MKTX-001',
        priority: 2,
        payload: {
          symbol: 'RELIANCE',
          target_price: 2900,
          current_price: 2905,
          direction: 'above',
        },
      };
      expect(
        (
          await call('POST', '/api/v1/events', {
            token: tokens.SERVICE,
            body: promo,
          })
        ).status,
      ).toBe(202);

      const rows = await eventually(async () => {
        const r = await prisma.notification.findMany({
          where: { userId: u.id, eventType: 'MKTX-001' },
          select: { channel: true, status: true, dndResult: true },
        });
        return r.length >= 2 &&
          r.every((x) => !['QUEUED', 'ROUTED', 'CREATED'].includes(x.status))
          ? r
          : false;
      });
      const sms = rows.find((r) => r.channel === 'sms');
      expect(sms).toMatchObject({ status: 'DND', dndResult: 'REGISTERED' });
      expect(
        rows
          .filter((r) => r.channel !== 'sms')
          .every((r) => ['SENT', 'DELIVERED'].includes(r.status)),
      ).toBe(true);
    });

    it('a non-registered user still receives the same promotional SMS', async () => {
      const u = await createUser({ dnd: 'NOT_REGISTERED' });
      const promo = {
        ...marginCall(u.id),
        event_type: 'MKTX-001',
        priority: 2,
        payload: {
          symbol: 'RELIANCE',
          target_price: 2900,
          current_price: 2905,
          direction: 'above',
        },
      };
      await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: promo,
      });
      const sms = await eventually(async () => {
        const r = await prisma.notification.findFirst({
          where: { userId: u.id, channel: 'sms' },
        });
        return r && ['SENT', 'DELIVERED'].includes(r.status) ? r : false;
      });
      expect(sms.dndResult).toBe('NOT_REGISTERED');
    });
  });

  describe('consent (spec A6.1 / C3.3 / B2.3)', () => {
    const consent = (userId: string, body: object, token = tokens.SERVICE) =>
      call('POST', `/api/v1/users/${userId}/consents`, { token, body });
    const promo = (userId: string, symbol: string) => ({
      ...marginCall(userId),
      event_type: 'MKTX-001',
      priority: 2,
      payload: {
        symbol,
        target_price: 2900,
        current_price: 2905,
        direction: 'above',
      },
    });
    const rowsFor = (userId: string, eventType: string) =>
      prisma.notification.findMany({
        where: { userId, eventType },
        select: { channel: true, status: true, consentRecordId: true },
      });
    const settled = (rows: { status: string }[]) =>
      rows.length >= 2 &&
      rows.every(
        (r) => !['QUEUED', 'ROUTED', 'CREATED', 'RETRYING'].includes(r.status),
      );

    it('POST records the event and answers 201 with the documented body', async () => {
      const u = await createUser({ consent: false });
      const r = await consent(u.id, {
        channel: 'sms',
        consent_type: 'OPT_IN',
        consent_text: 'I agree to receive SMS updates.',
        ip_address: '197.210.10.4',
        user_agent: 'Android-App/3.1',
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        user_id: u.id,
        channel: 'sms',
        consent_type: 'OPT_IN',
        granted: true,
      });
      expect(r.body.consent_id).toEqual(expect.any(String));
      expect(new Date(r.body.recorded_at).getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });

    it('rejects invalid consent events with the 422 shape; WhatsApp needs its OWN opt-in', async () => {
      const u = await createUser({ consent: false });
      const wrong = await consent(u.id, {
        channel: 'whatsapp',
        consent_type: 'OPT_IN',
        consent_text: 'I agree to receive WhatsApp.',
      });
      expect(wrong.status).toBe(422);
      expect(wrong.body.details[0]).toMatchObject({ field: 'consent_type' });
      const short = await consent(u.id, {
        channel: 'sms',
        consent_type: 'OPT_IN',
        consent_text: 'ok',
      });
      expect(short.status).toBe(422);
      expect(
        (
          await consent(u.id, {
            channel: 'sms',
            consent_type: 'OPT_IN',
            consent_text: 'I agree to receive SMS.',
            ip_address: 'not-an-ip',
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await consent(randomUUID(), {
            channel: 'sms',
            consent_type: 'OPT_IN',
            consent_text: 'I agree to receive SMS.',
          })
        ).status,
      ).toBe(404);
    });

    it('RBAC: only SERVICE and ADMIN may record; OPERATOR may read', async () => {
      const u = await createUser({ consent: false });
      const body = {
        channel: 'sms',
        consent_type: 'OPT_IN',
        consent_text: 'I agree to receive SMS.',
      };
      expect((await consent(u.id, body, tokens.OPERATOR)).status).toBe(403);
      expect(
        (
          await call('GET', `/api/v1/users/${u.id}/consents/status`, {
            token: tokens.OPERATOR,
          })
        ).status,
      ).toBe(200);
    });

    it('status lists every channel; history is newest-first and append-only', async () => {
      const u = await createUser({ consent: false });
      await consent(u.id, {
        channel: 'sms',
        consent_type: 'OPT_IN',
        consent_text: 'I agree to receive SMS.',
      });
      await consent(u.id, {
        channel: 'sms',
        consent_type: 'OPT_OUT',
        consent_text: 'Stop sending me SMS.',
      });

      const st = (
        await call('GET', `/api/v1/users/${u.id}/consents/status`, {
          token: tokens.SERVICE,
        })
      ).body;
      expect(st.channels.map((c: any) => [c.channel, c.status])).toEqual([
        ['sms', 'withdrawn'],
        ['email', 'none'],
        ['push', 'none'],
        ['whatsapp', 'none'],
        ['in_app', 'none'],
      ]);

      const h = (
        await call('GET', `/api/v1/users/${u.id}/consents?channel=sms`, {
          token: tokens.SERVICE,
        })
      ).body;
      expect(h.data.map((r: any) => r.consent_type)).toEqual([
        'OPT_OUT',
        'OPT_IN',
      ]); // both kept, newest first
      expect(h.data[0]).toMatchObject({
        granted: false,
        consent_text: 'Stop sending me SMS.',
      });
    });

    it('the DATABASE refuses to edit or delete a consent record (immutable audit log)', async () => {
      const u = await createUser();
      const rec = await prisma.consentRecord.findFirst({
        where: { userId: u.id },
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE consent_records SET granted = false WHERE id = '${rec!.id}'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM consent_records WHERE id = '${rec!.id}'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.consentRecord.update({
          where: { id: rec!.id },
          data: { granted: false },
        }),
      ).rejects.toThrow();
    });

    it('a user who never gave WhatsApp consent is NOT messaged there — while their transactional SMS and push still go out', async () => {
      const u = await createUser({ consent: false, dnd: 'NOT_REGISTERED' });
      await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: marginCall(u.id),
      });
      const rows = await eventually(async () => {
        const r = await rowsFor(u.id, 'RISK-001');
        return r.length >= 3 && settled(r) ? r : false;
      });
      const by = Object.fromEntries(rows.map((r) => [r.channel, r.status]));
      expect(by['whatsapp']).toBe('NO_CONSENT');
      expect(['SENT', 'DELIVERED']).toContain(by['sms']); // transactional: no consent needed
      expect(['SENT', 'DELIVERED']).toContain(by['push']);
    });

    it('a promotional EMAIL needs consent; opting out stops the very next one', async () => {
      const u = await createUser(); // has SMS/email/WhatsApp consent
      // Two different promotional event types, so the 15-minute same-type cooldown
      // is not what stops the second one.
      const email = (type: string, payload: object) => ({
        ...marginCall(u.id),
        event_type: type,
        priority: 3,
        payload,
      });

      await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: email('MKTX-004', { symbol: 'INFY', milestone: '52-week high' }),
      });
      const first = await eventually(async () => {
        const r = await prisma.notification.findFirst({
          where: { userId: u.id, eventType: 'MKTX-004', channel: 'email' },
        });
        return r && ['SENT', 'DELIVERED'].includes(r.status) ? r : false;
      });
      expect(first.consentRecordId).toEqual(expect.any(String)); // the authorising record is stored on the message

      expect(
        (
          await consent(u.id, {
            channel: 'email',
            consent_type: 'OPT_OUT',
            consent_text: 'Stop sending me marketing email.',
          })
        ).status,
      ).toBe(201);

      await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: email('MKTX-005', { company: 'TCS', date: '2026-10-10' }),
      });
      const second = await eventually(async () => {
        const r = await prisma.notification.findFirst({
          where: { userId: u.id, eventType: 'MKTX-005', channel: 'email' },
        });
        return r && !['QUEUED', 'ROUTED', 'CREATED'].includes(r.status)
          ? r
          : false;
      });
      expect(second.status).toBe('NO_CONSENT');
      const log = await prisma.notificationStateLog.findFirst({
        where: { notificationId: second.id, toStatus: 'NO_CONSENT' },
      });
      expect((log!.metadata as any).reason).toBe('CONSENT_WITHDRAWN');
    });

    it('the compliance audits show the DND proof for every SMS and the consent behind every promotional send', async () => {
      const u = await createUser();
      await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: promo(u.id, 'HDFC'),
      });
      await eventually(async () => {
        const r = await prisma.notification.findFirst({
          where: { userId: u.id, eventType: 'MKTX-001', channel: 'sms' },
        });
        return r && ['SENT', 'DELIVERED'].includes(r.status) ? r : false;
      });

      const sms = (
        await call('GET', '/api/v1/compliance/audit/sms?limit=100', {
          token: tokens.OPERATOR,
        })
      ).body;
      expect(sms.summary.sent_without_dnd_check).toBe(0); // the number an auditor looks for
      expect(sms.data.find((r: any) => r.user_id === u.id)).toMatchObject({
        dnd_checked: true,
        dnd_result: 'NOT_REGISTERED',
        classification: 'PROMOTIONAL',
      });

      const pc = (
        await call(
          'GET',
          '/api/v1/compliance/audit/promotional-consent?limit=100',
          { token: tokens.ADMIN },
        )
      ).body;
      const row = pc.data.find(
        (r: any) => r.user_id === u.id && r.channel === 'sms',
      );
      expect(row).toMatchObject({
        consent_missing: false,
        consent: {
          consent_type: 'OPT_IN',
          granted: true,
          ip_address: '197.210.10.4',
        },
      });
      expect(row.consent.consent_text).toBe(
        'E2E: I agree to receive notifications.',
      );
    });

    it('audits are ADMIN/OPERATOR only, and reject windows over 90 days', async () => {
      expect(
        (
          await call('GET', '/api/v1/compliance/audit/sms', {
            token: tokens.SERVICE,
          })
        ).status,
      ).toBe(403);
      const long = await call(
        'GET',
        '/api/v1/compliance/audit/sms?from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
        { token: tokens.OPERATOR },
      );
      expect(long.status).toBe(422);
    });

    it('erasure anonymises the user but RETAINS the consent evidence', async () => {
      const u = await createUser();
      const before = await prisma.consentRecord.count({
        where: { userId: u.id },
      });
      const r = await call('DELETE', `/api/v1/users/${u.id}/data`, {
        token: tokens.ADMIN,
      });
      expect(r.status).toBe(200);
      expect(r.body.consent_records_retained).toBe(before);
      expect(
        await prisma.consentRecord.count({ where: { userId: u.id } }),
      ).toBe(before);
    });
  });

  describe('digests (spec Day 5, A6.3, Appendix B)', () => {
    const event = (
      userId: string,
      type: string,
      payload: object = { note: type },
    ) => ({
      ...marginCall(userId),
      event_type: type,
      priority: 3,
      payload,
    });
    const send = (userId: string, type: string, payload?: object) =>
      call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: event(userId, type, payload),
      });
    const statusOf = async (userId: string, type: string) =>
      await prisma.notification.findMany({
        where: { userId, eventType: type },
        select: { id: true, channel: true, status: true },
      });
    const digestsFor = (userId: string) =>
      prisma.notification.findMany({
        where: { userId, eventType: 'DIGEST' },
        select: {
          id: true,
          channel: true,
          status: true,
          personalisationData: true,
          metadata: true,
        },
      });

    it('a user who chose an HOURLY digest gets ONE digest instead of separate notifications', async () => {
      const u = await createUser();
      const put = await call('PUT', `/api/v1/users/${u.id}/preferences`, {
        token: tokens.SERVICE,
        body: {
          category: 'MKTX',
          channels: {
            push: true,
            in_app: true,
            email: true,
            sms: true,
            whatsapp: true,
          },
          digest_mode: 'hourly',
        },
      });
      expect(put.status).toBe(200);

      await send(u.id, 'MKTX-004', {
        symbol: 'INFY',
        milestone: '52-week high',
      });
      await send(u.id, 'MKTX-005', { company: 'TCS', date: '2026-10-10' });

      // both are HELD — nothing was sent individually
      const held = await eventually(async () => {
        const rows = [
          ...(await statusOf(u.id, 'MKTX-004')),
          ...(await statusOf(u.id, 'MKTX-005')),
        ];
        return rows.length === 2 &&
          rows.every((r) => r.status === 'DIGEST_PENDING')
          ? rows
          : false;
      });
      expect(held.map((r) => r.channel)).toEqual(['pending', 'pending']);
      expect(await digestsFor(u.id)).toHaveLength(0);

      // the hour rolls over → the flush builds and sends the digest
      expect(
        await app.get(DigestFlushService).flushDue(Date.now() + 2 * 3_600_000),
      ).toBeGreaterThanOrEqual(1);

      const digests = await eventually(async () => {
        const d = await digestsFor(u.id);
        return d.length === 2 &&
          d.every((x) => ['SENT', 'DELIVERED'].includes(x.status))
          ? d
          : false;
      });
      expect(digests.map((d) => d.channel).sort()).toEqual(['in_app', 'push']); // one digest, two free channels
      const data = digests[0].personalisationData as {
        count: number;
        items: { text: string }[];
        source: string;
      };
      expect(data).toMatchObject({ count: 2, source: 'hourly' });
      expect(data.items).toHaveLength(2);

      // each folded notification ends DIGESTED and points at the digest
      const folded = await prisma.notification.findMany({
        where: { userId: u.id, eventType: { in: ['MKTX-004', 'MKTX-005'] } },
      });
      expect(folded.every((n) => n.status === 'DIGESTED')).toBe(true);
      const log = await prisma.notificationStateLog.findFirst({
        where: { notificationId: folded[0].id, toStatus: 'DIGESTED' },
      });
      expect(digests.map((d) => d.id)).toContain(
        (log!.metadata as any).digestNotificationId,
      );
    });

    it('CRITICAL and regulator-mandated events are NEVER digested, whatever the user chose', async () => {
      const u = await createUser({ dnd: 'NOT_REGISTERED' });
      for (const category of ['RISK', 'TXNX']) {
        await call('PUT', `/api/v1/users/${u.id}/preferences`, {
          token: tokens.SERVICE,
          body: {
            category,
            channels: {
              push: true,
              sms: true,
              in_app: true,
              email: true,
              whatsapp: true,
            },
            digest_mode: 'daily',
          },
        });
      }
      await call('POST', '/api/v1/events', {
        token: tokens.SERVICE,
        body: marginCall(u.id),
      });
      await send(u.id, 'TXNX-005', { amount: 5000, source: 'Paystack' });

      const rows = await eventually(async () => {
        const r = await prisma.notification.findMany({
          where: {
            userId: u.id,
            eventType: { in: ['RISK-001', 'TXNX-005'] },
            channel: 'sms',
          },
          select: { eventType: true, status: true },
        });
        return r.length === 2 &&
          r.every((x) => ['SENT', 'DELIVERED'].includes(x.status))
          ? r
          : false;
      });
      expect(rows).toHaveLength(2); // delivered immediately, as SMS — not held for a digest
      expect(await digestsFor(u.id)).toHaveLength(0);
      expect(
        await prisma.notification.count({
          where: { userId: u.id, status: 'DIGEST_PENDING' },
        }),
      ).toBe(0);
    });

    it('MORE than 5 notifications held by quiet hours become ONE morning digest; 3 are simply released', async () => {
      // A quiet window that ends 60–120 s from now (in the user's own timezone).
      // The end is truncated to the minute, so `+2` guarantees at least 60 s of
      // margin — with `+1` the window could close before all events were held.
      const lagos = (offsetMin: number) =>
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Lagos',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(Date.now() + offsetMin * 60_000));
      const quietUser = async () => {
        const u = await createUser();
        await prisma.user.update({
          where: { id: u.id },
          data: { quietHoursStart: lagos(-60), quietHoursEnd: lagos(2) },
        });
        return u;
      };
      const many = await quietUser(); // 6 pile up
      const few = await quietUser(); // 3 pile up
      const sixTypes = [
        'MKTX-003',
        'MKTX-004',
        'MKTX-005',
        'SIPX-004',
        'SIPX-005',
        'REGX-005',
      ];
      for (const t of sixTypes) await send(many.id, t);
      for (const t of sixTypes.slice(0, 3)) await send(few.id, t);

      // everything is held by quiet hours
      await eventually(async () => {
        const [a, b] = await Promise.all([
          prisma.notification.count({
            where: { userId: many.id, status: 'QUIET' },
          }),
          prisma.notification.count({
            where: { userId: few.id, status: 'QUIET' },
          }),
        ]);
        return a === 6 && b === 3 ? true : false;
      });

      // …then the window opens: the pile of 6 is folded, the 3 are released one by one
      const flush = app.get(DigestFlushService);
      await eventually(async () => {
        const pending = await prisma.notification.count({
          where: { userId: many.id, status: 'DIGEST_PENDING' },
        });
        if (pending === 6) {
          await flush.flushDue(Date.now() + 60_000);
        }
        return (await digestsFor(many.id)).length === 2;
      }, 150_000);

      const digests = await digestsFor(many.id);
      expect(digests[0].personalisationData as any).toMatchObject({
        count: 6,
        more: 1,
        source: 'quiet',
      });
      expect(
        await prisma.notification.count({
          where: {
            userId: many.id,
            eventType: { in: sixTypes },
            status: 'DIGESTED',
          },
        }),
      ).toBe(6);

      const released = await eventually(async () => {
        const r = await prisma.notification.findMany({
          where: { userId: few.id, eventType: { in: sixTypes } },
          select: { status: true },
        });
        return r.length >= 3 &&
          r.every(
            (x) =>
              !['QUIET', 'ROUTED', 'QUEUED', 'DIGEST_PENDING'].includes(
                x.status,
              ),
          )
          ? r
          : false;
      }, 60_000);
      expect(
        released.every((r) => ['SENT', 'DELIVERED'].includes(r.status)),
      ).toBe(true);
      expect(await digestsFor(few.id)).toHaveLength(0);
    }, 240_000);

    it('the preference API rejects nothing new: hourly/daily/immediate round-trip', async () => {
      const u = await createUser();
      await call('PUT', `/api/v1/users/${u.id}/preferences`, {
        token: tokens.SERVICE,
        body: {
          category: 'SIPX',
          channels: { push: true },
          digest_mode: 'daily',
        },
      });
      const get = await call('GET', `/api/v1/users/${u.id}/preferences`, {
        token: tokens.OPERATOR,
      });
      expect(
        get.body.category_preferences.find((c: any) => c.category === 'SIPX')
          .digest_mode,
      ).toBe('daily');
    });
  });

  describe('preferences', () => {
    it('GET has the documented shape; PUT accepts the spec body and reports warnings + cache invalidation', async () => {
      const u = await createUser();
      const put = await call('PUT', `/api/v1/users/${u.id}/preferences`, {
        token: tokens.SERVICE,
        body: {
          category: 'MKTX',
          channels: {
            sms: false,
            email: false,
            push: true,
            whatsapp: false,
            in_app: true,
          },
          digest_mode: 'daily',
        },
      });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        status: 'updated',
        category: 'MKTX',
        cache_invalidated: true,
      });
      expect(put.body.warnings.length).toBeGreaterThan(0);

      const get = await call('GET', `/api/v1/users/${u.id}/preferences`, {
        token: tokens.OPERATOR,
      });
      expect(get.status).toBe(200);
      expect(get.body.global_preferences).toMatchObject({
        digest_mode: 'none',
      });
      expect(get.body.category_preferences).toContainEqual({
        category: 'MKTX',
        channels: expect.objectContaining({ sms: false, push: true }),
        digest_mode: 'daily',
      });
      expect(get.body.regulatory_overrides[0]).toMatchObject({
        cannot_disable: true,
      });
    });

    it('rejects a quiet-hours window shorter than 6 hours', async () => {
      const u = await createUser();
      const r = await call('PUT', `/api/v1/users/${u.id}/preferences`, {
        token: tokens.SERVICE,
        body: {
          category: 'MKTX',
          channels: { push: true },
          quiet_hours_start: '12:00',
          quiet_hours_end: '13:00',
        },
      });
      expect(r.status).toBe(422);
    });
  });

  describe('Nigerian payment webhook → TXNX-005', () => {
    const sign = (body: string) =>
      createHmac('sha512', 'sk_e2e_secret').update(body).digest('hex');

    it("a correctly signed Paystack charge.success becomes a delivered naira SMS in the user's language", async () => {
      const u = await createUser({ language: 'PCM', market: 'NG' });
      const payload = JSON.stringify({
        event: 'charge.success',
        data: {
          id: Date.now(),
          status: 'success',
          reference: `ref-${randomUUID()}`,
          amount: 500000,
          currency: 'NGN',
          customer: { email: u.email },
          metadata: {},
        },
      });
      const r = await call('POST', '/api/webhooks/payments/paystack', {
        body: payload,
        headers: { 'x-paystack-signature': sign(payload) },
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'accepted' }); // attributed through the email BLIND INDEX

      const sms = await eventually(async () => {
        const n = await prisma.notification.findFirst({
          where: { userId: u.id, channel: 'sms' },
        });
        return n && ['SENT', 'DELIVERED'].includes(n.status) ? n : false;
      });
      expect(sms.provider).toBe('termii');
      expect((sms.renderedContent as any).body).toBe(
        'Money don enter: NGN 5,000 from Paystack. -WealthBridge',
      );
    });

    it('rejects a forged signature and a missing one', async () => {
      const payload = JSON.stringify({
        event: 'charge.success',
        data: { id: 1, reference: 'r', amount: 1, currency: 'NGN' },
      });
      expect(
        (
          await call('POST', '/api/webhooks/payments/paystack', {
            body: payload,
            headers: { 'x-paystack-signature': 'f'.repeat(128) },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await call('POST', '/api/webhooks/payments/paystack', {
            body: payload,
          })
        ).status,
      ).toBe(401);
    });

    it('a webhook for an unconfigured provider fails closed', async () => {
      expect(
        (
          await call('POST', '/api/webhooks/payments/opay', {
            body: JSON.stringify({
              type: 'transaction-status',
              sha512: 'x',
              payload: {},
            }),
          })
        ).status,
      ).toBe(401);
    });
  });

  describe('operations endpoints', () => {
    it('/health reports every component including providers; /ready and /live respond', async () => {
      const h = await call('GET', '/health');
      expect(h.status).toBe(200);
      expect(Object.keys(h.body.components)).toEqual([
        'database',
        'redis',
        'kafka',
        'rabbitmq',
        'providers',
      ]);
      expect((await call('GET', '/ready')).status).toBe(200);
      expect((await call('GET', '/live')).status).toBe(200);
    });

    it("/metrics exposes the spec's required Prometheus metrics", async () => {
      const m = await call('GET', '/metrics');
      expect(m.status).toBe(200);
      for (const name of [
        'notification_events_received_total',
        'notification_delivery_total',
        'notification_dlq_depth',
        'delivery_provider_circuit_state',
        'dnd_violations_detected_total',
      ]) {
        expect(m.body).toContain(name);
      }
    });

    it('serves Swagger UI', async () => {
      expect((await call('GET', '/api-docs')).status).toBeLessThan(400);
    });

    it('echoes a correlation id header on every response', async () => {
      const r = await call('GET', '/health', {
        headers: { 'x-correlation-id': 'trace-me-123' },
      });
      expect(r.headers['x-correlation-id']).toBe('trace-me-123');
    });
  });
});
