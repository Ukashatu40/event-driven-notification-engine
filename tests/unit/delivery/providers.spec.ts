// tests/unit/delivery/providers.spec.ts
import { Msg91Provider } from '../../../src/delivery/providers/sms/msg91.provider';
import { TwilioProvider } from '../../../src/delivery/providers/sms/twilio.provider';
import { WhatsAppProvider } from '../../../src/delivery/providers/whatsapp/whatsapp-cloud.provider';
import { FcmProvider } from '../../../src/delivery/providers/push/fcm.provider';
import { InAppProvider } from '../../../src/delivery/providers/inapp/inapp.provider';
import { NodemailerProvider } from '../../../src/delivery/providers/email/nodemailer.provider';
import type {
  IDeliveryProvider,
  PreparedNotification,
} from '../../../src/delivery/providers/delivery-provider.interface';

const msg = (
  over: Partial<PreparedNotification> = {},
): PreparedNotification => ({
  notificationId: 'n-1',
  userId: 'u-1',
  channel: 'sms',
  recipient: '+919876543210',
  body: 'hello',
  title: 'T',
  subject: 'S',
  priority: 1,
  correlationId: 'c-1',
  ...over,
});
const cfg = (env: Record<string, string | number> = {}) =>
  ({ get: (k: string) => env[k] }) as never;

const realFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock as never;
});
afterAll(() => {
  global.fetch = realFetch;
});

const ok = (json: unknown) =>
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => json,
  });
const fail = (status: number, json: unknown) =>
  fetchMock.mockResolvedValue({ ok: false, status, json: async () => json });

/** Behaviour every provider must share (the DeliveryProvider contract, spec A3.3). */
const contract = (
  name: string,
  make: () => IDeliveryProvider,
  valid: string,
  invalid: string | null,
) =>
  describe(`${name} — provider contract`, () => {
    it('identifies itself', () => {
      const p = make();
      expect(p.providerName).toBeTruthy();
      expect(p.channel).toBeTruthy();
    });
    it('validates recipients', async () => {
      expect((await make().validateRecipient(valid)).valid).toBe(true);
      if (invalid === null) return; // e.g. in-app addresses a user id: nothing is invalid
      const bad = await make().validateRecipient(invalid);
      expect(bad.valid).toBe(false);
      expect(bad.reason).toBeTruthy();
    });
    it('reports a quota, a health status and a delivery status', async () => {
      const p = make();
      expect((await p.getQuota()).remaining).toBeGreaterThanOrEqual(0);
      expect(typeof (await p.healthCheck())).toBe('boolean');
      expect((await p.getStatus('x')).externalId).toBe('x');
    });
  });

contract('MSG91', () => new Msg91Provider(cfg()), '+919876543210', '12345');
contract('Twilio', () => new TwilioProvider(cfg()), '+14155552671', 'abc');
contract(
  'WhatsApp',
  () => new WhatsAppProvider(cfg()),
  '+2348031234567',
  '08031234567',
);
contract('FCM', () => new FcmProvider(cfg()), 'x'.repeat(150), 'short');
contract(
  'Nodemailer',
  () => new NodemailerProvider(cfg()),
  'ada@example.ng',
  'not-an-email',
);
contract('InApp', () => new InAppProvider(), 'anything', null);

describe('mock mode (no credentials) — a labelled, simulated receipt', () => {
  it.each([
    ['MSG91', () => new Msg91Provider(cfg()), 'mock_msg91_'],
    ['Twilio', () => new TwilioProvider(cfg()), 'mock_twilio_'],
    ['WhatsApp', () => new WhatsAppProvider(cfg()), 'mock_wa_'],
    ['FCM', () => new FcmProvider(cfg()), 'mock_fcm_'],
  ])(
    '%s simulates success and never calls the network',
    async (_n, make, prefix) => {
      const r = await make().send(msg());
      expect(r).toMatchObject({ success: true, receipt: 'simulated' });
      expect(r.externalId).toMatch(new RegExp(`^${prefix}`));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('in-app confirms delivery immediately (the store write IS the delivery)', async () => {
    const r = await new InAppProvider().send(msg({ channel: 'in_app' }));
    expect(r).toMatchObject({
      success: true,
      receipt: 'immediate',
      externalId: 'inapp_n-1',
    });
  });
});

describe('MSG91 (real mode)', () => {
  const p = () =>
    new Msg91Provider(cfg({ MSG91_API_KEY: 'k', MSG91_SENDER_ID: 'WLTHBR' }));

  it('posts the transactional route with the number sans "+" and the auth key header', async () => {
    ok({ type: 'success', request_id: 'r-1' });
    const r = await p().send(msg());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('msg91.com');
    expect(init.headers.authkey).toBe('k');
    expect(JSON.parse(init.body)).toMatchObject({
      sender: 'WLTHBR',
      route: '4',
      sms: [{ message: 'hello', to: ['919876543210'] }],
    });
    expect(r).toMatchObject({ success: true, externalId: 'r-1' });
    expect(r.receipt).toBeUndefined(); // a real send waits for a real DLR
  });

  it('reports an API error body as a failure', async () => {
    ok({ type: 'error', code: '301', message: 'Insufficient balance' });
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: '301',
      errorMessage: 'Insufficient balance',
    });
  });

  it('reports HTTP failures and network errors', async () => {
    fail(503, {});
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: '503',
    });
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
    });
  });
});

describe('Twilio (real mode)', () => {
  const p = () =>
    new TwilioProvider(
      cfg({
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_FROM_NUMBER: '+15005550006',
      }),
    );

  it("posts a form-encoded message with Basic auth to the account's Messages endpoint", async () => {
    ok({ sid: 'SM1' });
    const r = await p().send(msg());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json',
    );
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('AC1:tok').toString('base64')}`,
    );
    expect(new URLSearchParams(init.body).get('To')).toBe('+919876543210');
    expect(new URLSearchParams(init.body).get('From')).toBe('+15005550006');
    expect(r).toMatchObject({ success: true, externalId: 'SM1' });
  });

  it('maps a Twilio error and a network failure to failures', async () => {
    fail(400, { code: 21211, message: 'Invalid To number' });
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: '21211',
      errorMessage: 'Invalid To number',
    });
    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
    });
  });
});

describe('WhatsApp Cloud API (real mode)', () => {
  const p = () =>
    new WhatsAppProvider(
      cfg({ WHATSAPP_PHONE_ID: 'pid', WHATSAPP_ACCESS_TOKEN: 'tok' }),
    );

  it('sends an approved TEMPLATE with resolved parameters when the notification carries one', async () => {
    ok({ messages: [{ id: 'wamid.1' }] });
    const r = await p().send(
      msg({
        channel: 'whatsapp',
        data: {
          templateName: 'order_executed_v2',
          resolvedParameters: ['Reliance', '10'],
        },
      }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v18.0/pid/messages');
    const body = JSON.parse(init.body);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('order_executed_v2');
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Reliance' },
      { type: 'text', text: '10' },
    ]);
    expect(r).toMatchObject({ success: true, externalId: 'wamid.1' });
  });

  it('falls back to a plain text message without a template', async () => {
    ok({ messages: [{ id: 'w2' }] });
    await p().send(msg({ channel: 'whatsapp' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      type: 'text',
      text: { body: 'hello' },
    });
  });

  it('reports API and network errors', async () => {
    fail(429, { error: { message: 'rate limit' } });
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: '429',
    });
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
    });
  });
});

describe('FCM (real mode)', () => {
  const p = () => new FcmProvider(cfg({ FCM_PROJECT_ID: 'proj' }));

  it('posts to the HTTP v1 endpoint with high priority for urgent events and stringified data', async () => {
    ok({ name: 'projects/proj/messages/1' });
    const r = await p().send(
      msg({ channel: 'push', priority: 1, data: { action: 'open', n: 5 } }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://fcm.googleapis.com/v1/projects/proj/messages:send',
    );
    const m = JSON.parse(init.body).message;
    expect(m.android.priority).toBe('high');
    expect(m.apns.headers['apns-priority']).toBe('10');
    expect(m.data).toEqual({ action: 'open', n: '5' });
    expect(r).toMatchObject({
      success: true,
      externalId: 'projects/proj/messages/1',
    });
  });

  it('uses normal priority for low-priority events', async () => {
    ok({ name: 'x' });
    await p().send(msg({ channel: 'push', priority: 5 }));
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body).message.android.priority,
    ).toBe('normal');
  });

  it('reports API and network errors', async () => {
    fail(401, { error: 'unauthenticated' });
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: '401',
    });
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await p().send(msg())).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
    });
  });
});

describe('Nodemailer', () => {
  const sendMail = jest.fn();

  const withTransport = async (env: Record<string, string> = {}) => {
    jest.resetModules();
    jest.doMock('nodemailer', () => ({
      createTestAccount: jest
        .fn()
        .mockRejectedValue(new Error('ethereal down')),
      createTransport: jest.fn(() => ({ sendMail })),
      getTestMessageUrl: () => 'https://ethereal.test/m/1',
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      NodemailerProvider: P,
    } = require('../../../src/delivery/providers/email/nodemailer.provider');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nm = require('nodemailer');
    const provider = new P(cfg(env));
    await provider.onModuleInit();
    return { provider, nm };
  };

  it('does NOT crash startup when the Ethereal signup fails — falls back to an offline transport', async () => {
    const { nm } = await withTransport();
    expect(nm.createTransport).toHaveBeenCalledWith({ jsonTransport: true });
  });

  it('uses real SMTP credentials when configured', async () => {
    const { nm } = await withTransport({
      SMTP_HOST: 'smtp.x',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
    });
    expect(nm.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.x',
        auth: { user: 'u', pass: 'p' },
      }),
    );
    expect(nm.createTestAccount).not.toHaveBeenCalled();
  });

  it('sends mail and returns the message id', async () => {
    const { provider } = await withTransport();
    sendMail.mockResolvedValue({ messageId: '<m1@x>' });
    const r = await provider.send(
      msg({ channel: 'email', recipient: 'ada@example.ng', subject: 'Hi' }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@example.ng',
        subject: 'Hi',
        text: 'hello',
      }),
    );
    expect(r).toMatchObject({ success: true, externalId: '<m1@x>' });
  });

  it('reports an SMTP failure instead of throwing', async () => {
    const { provider } = await withTransport();
    sendMail.mockRejectedValue(new Error('550 mailbox unavailable'));
    expect(await provider.send(msg({ channel: 'email' }))).toMatchObject({
      success: false,
      errorCode: 'SMTP_ERROR',
    });
  });
});
