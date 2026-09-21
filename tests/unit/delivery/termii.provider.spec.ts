// tests/unit/delivery/termii.provider.spec.ts
import { TermiiProvider } from '../../../src/delivery/providers/sms/termii.provider';
import { PreparedNotification } from '../../../src/delivery/providers/delivery-provider.interface';

const msg = (
  over: Partial<PreparedNotification> = {},
): PreparedNotification => ({
  notificationId: 'n-1',
  userId: 'u-1',
  channel: 'sms',
  recipient: '+2348031234567',
  body: 'Money don enter: N5,000',
  priority: 2,
  correlationId: 'c-1',
  ...over,
});

const provider = (env: Record<string, string> = {}) =>
  new TermiiProvider({ get: (k: string) => env[k] } as never);

describe('TermiiProvider', () => {
  const realFetch = global.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = fetchMock as never;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('route selection (compliance-critical)', () => {
    it('TRANSACTIONAL → "dnd" route', () => {
      expect(
        provider().routeFor(msg({ classification: 'TRANSACTIONAL' })),
      ).toBe('dnd');
    });
    it('PROMOTIONAL → "generic" route (never the DND-bypassing route)', () => {
      expect(provider().routeFor(msg({ classification: 'PROMOTIONAL' }))).toBe(
        'generic',
      );
    });
    it('unknown classification → "generic" (fail safe)', () => {
      expect(provider().routeFor(msg())).toBe('generic');
    });
  });

  describe('phone normalisation', () => {
    it.each([
      ['+2348031234567', '2348031234567'],
      ['08031234567', '2348031234567'],
      ['234 803 123 4567', '2348031234567'],
    ])('%s → %s', (input, expected) => {
      expect(TermiiProvider.normalisePhone(input)).toBe(expected);
    });
  });

  describe('validateRecipient', () => {
    it.each(['+2348031234567', '08031234567', '+2349051234567', '07012345678'])(
      'accepts %s',
      async (n) =>
        expect((await provider().validateRecipient(n)).valid).toBe(true),
    );
    it.each(['+919876543210', '12345', '+2341234567890', ''])(
      'rejects %s',
      async (n) =>
        expect((await provider().validateRecipient(n)).valid).toBe(false),
    );
  });

  describe('send', () => {
    it('simulates success without an API key (dev/test)', async () => {
      const r = await provider().send(msg());
      expect(r.success).toBe(true);
      expect(r.externalId).toMatch(/^mock_termii_/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts to the Termii API with route, type and normalised number', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ code: 'ok', message_id: 'abc123' }),
      });
      const r = await provider({ TERMII_API_KEY: 'k' }).send(
        msg({ classification: 'TRANSACTIONAL' }),
      );

      expect(r).toMatchObject({ success: true, externalId: 'abc123' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.ng.termii.com/api/sms/send');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        to: '2348031234567',
        channel: 'dnd',
        type: 'plain',
        sms: 'Money don enter: N5,000',
      });
    });

    it('uses type "unicode" for text outside the GSM-7 alphabet', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ code: 'ok', message_id: '1' }),
      });
      await provider({ TERMII_API_KEY: 'k' }).send(
        msg({ body: 'Owó wọlé: ₦5,000' }),
      );
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).type).toBe('unicode');
    });

    it('returns a failure (not a throw) on an API error code', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          code: 'insufficient_balance',
          message: 'No credit',
        }),
      });
      const r = await provider({ TERMII_API_KEY: 'k' }).send(msg());
      expect(r).toMatchObject({
        success: false,
        errorCode: 'insufficient_balance',
      });
    });

    it('returns a failure on a network error so the circuit breaker can count it', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const r = await provider({ TERMII_API_KEY: 'k' }).send(msg());
      expect(r).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' });
    });
  });
});
