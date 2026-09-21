// tests/unit/payments/adapters.spec.ts
import { createHmac } from 'crypto';
import { FlutterwaveAdapter } from '../../../src/payments/adapters/flutterwave.adapter';
import { InterswitchAdapter } from '../../../src/payments/adapters/interswitch.adapter';
import { OpayAdapter } from '../../../src/payments/adapters/opay.adapter';
import { PaystackAdapter } from '../../../src/payments/adapters/paystack.adapter';

const cfg = (env: Record<string, string>) =>
  ({ get: (k: string) => env[k] }) as never;
const raw = (o: unknown) => Buffer.from(JSON.stringify(o));
const hmac = (alg: string, key: string, data: string | Buffer) =>
  createHmac(alg, key).update(data).digest('hex');

describe('PaystackAdapter', () => {
  const adapter = new PaystackAdapter(
    cfg({ PAYSTACK_SECRET_KEY: 'sk_test_x' }),
  );
  const body = {
    event: 'charge.success',
    data: {
      id: 302961,
      status: 'success',
      reference: 'ref-1',
      amount: 500000,
      currency: 'NGN',
      customer: { email: 'ada@example.ng' },
      metadata: { user_id: 'u-1' },
    },
  };

  it('accepts a correct HMAC-SHA512 signature over the raw body', () => {
    const b = raw(body);
    expect(
      adapter.verify(b, {
        'x-paystack-signature': hmac('sha512', 'sk_test_x', b),
      }),
    ).toBe(true);
  });

  it('rejects a wrong signature, a missing header, and a tampered body', () => {
    const b = raw(body);
    const good = hmac('sha512', 'sk_test_x', b);
    expect(adapter.verify(b, { 'x-paystack-signature': 'deadbeef' })).toBe(
      false,
    );
    expect(adapter.verify(b, {})).toBe(false);
    const tampered = raw({ ...body, data: { ...body.data, amount: 1 } });
    expect(adapter.verify(tampered, { 'x-paystack-signature': good })).toBe(
      false,
    );
  });

  it('fails CLOSED when the secret is not configured', () => {
    const noSecret = new PaystackAdapter(cfg({}));
    const b = raw(body);
    expect(
      noSecret.verify(b, { 'x-paystack-signature': hmac('sha512', '', b) }),
    ).toBe(false);
  });

  it('parses charge.success: kobo → naira, user id and email', () => {
    expect(adapter.parse(body)).toEqual({
      provider: 'paystack',
      providerEventId: '302961',
      reference: 'ref-1',
      amount: 5000,
      currency: 'NGN',
      userId: 'u-1',
      email: 'ada@example.ng',
    });
  });

  it('ignores other events and unsuccessful charges', () => {
    expect(adapter.parse({ event: 'transfer.success', data: {} })).toBeNull();
    expect(
      adapter.parse({ ...body, data: { ...body.data, status: 'failed' } }),
    ).toBeNull();
  });
});

describe('FlutterwaveAdapter', () => {
  const adapter = new FlutterwaveAdapter(
    cfg({ FLUTTERWAVE_SECRET_HASH: 'my-secret-hash' }),
  );
  const body = {
    event: 'charge.completed',
    data: {
      id: 285959875,
      tx_ref: 'tx-1',
      amount: 5000,
      currency: 'NGN',
      status: 'successful',
      customer: { email: 'ada@example.ng' },
      meta: { user_id: 'u-2' },
    },
  };

  it('accepts the echoed secret hash and rejects anything else', () => {
    expect(adapter.verify(raw(body), { 'verif-hash': 'my-secret-hash' })).toBe(
      true,
    );
    expect(adapter.verify(raw(body), { 'verif-hash': 'wrong' })).toBe(false);
    expect(adapter.verify(raw(body), {})).toBe(false);
  });

  it('fails CLOSED when no secret hash is configured', () => {
    const noSecret = new FlutterwaveAdapter(cfg({}));
    expect(noSecret.verify(raw(body), { 'verif-hash': '' })).toBe(false);
    expect(noSecret.verify(raw(body), { 'verif-hash': 'undefined' })).toBe(
      false,
    );
  });

  it('parses charge.completed with amount in major units', () => {
    expect(adapter.parse(body)).toMatchObject({
      provider: 'flutterwave',
      providerEventId: '285959875',
      reference: 'tx-1',
      amount: 5000,
      userId: 'u-2',
      email: 'ada@example.ng',
    });
  });

  it('ignores non-successful charges', () => {
    expect(
      adapter.parse({ ...body, data: { ...body.data, status: 'failed' } }),
    ).toBeNull();
  });
});

describe('OpayAdapter', () => {
  const secret = 'opay-private-key';
  const payload = {
    amount: '500000',
    currency: 'NGN',
    reference: '11111111-1111-4111-8111-111111111111:abc',
    refunded: false,
    status: 'SUCCESS',
    timestamp: '2026-09-21T10:00:00Z',
    token: 'tok',
    transactionId: 'txn-9',
  };
  const adapter = new OpayAdapter(cfg({ OPAY_SECRET_KEY: secret }));
  const signed = (p = payload, key = secret) => ({
    type: 'transaction-status',
    sha512: hmac('sha3-512', key, OpayAdapter.signingString(p)),
    payload: p,
  });

  it('builds the exact string OPay documents (refunded → t/f, quoted values)', () => {
    expect(OpayAdapter.signingString(payload)).toBe(
      '{Amount:"500000",Currency:"NGN",Reference:"11111111-1111-4111-8111-111111111111:abc",' +
        'Refunded:f,Status:"SUCCESS",Timestamp:"2026-09-21T10:00:00Z",Token:"tok",TransactionID:"txn-9"}',
    );
    expect(OpayAdapter.signingString({ ...payload, refunded: true })).toContain(
      'Refunded:t',
    );
  });

  it('accepts a valid HMAC-SHA3-512 signature carried in the body', () => {
    expect(adapter.verify(raw(signed()), {})).toBe(true);
  });

  it('rejects a signature made with another key, or over altered fields', () => {
    expect(adapter.verify(raw(signed(payload, 'other-key')), {})).toBe(false);
    const forged = {
      ...signed(),
      payload: { ...payload, amount: '999999999' },
    };
    expect(adapter.verify(raw(forged), {})).toBe(false);
  });

  it('rejects a missing sha512, malformed JSON, and an unconfigured secret', () => {
    expect(
      adapter.verify(raw({ type: 'transaction-status', payload }), {}),
    ).toBe(false);
    expect(adapter.verify(Buffer.from('not json'), {})).toBe(false);
    expect(new OpayAdapter(cfg({})).verify(raw(signed()), {})).toBe(false);
  });

  it('parses a SUCCESS callback; user id comes from the "<userId>:…" reference', () => {
    expect(adapter.parse(signed())).toMatchObject({
      provider: 'opay',
      providerEventId: 'txn-9',
      amount: 5000,
      userId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('ignores non-SUCCESS statuses and other callback types', () => {
    expect(adapter.parse(signed({ ...payload, status: 'FAIL' }))).toBeNull();
    expect(adapter.parse({ type: 'refund', payload })).toBeNull();
  });
});

describe('InterswitchAdapter', () => {
  const adapter = new InterswitchAdapter(
    cfg({ INTERSWITCH_SECRET_KEY: 'isw-secret' }),
  );
  const body = {
    event: 'TRANSACTION.COMPLETED',
    uuid: 'evt-1',
    timestamp: 1594646111460,
    data: {
      amount: 1200000,
      currencyCode: '566',
      merchantReference: 'mref-1',
      responseCode: '00',
      merchantCustomerId: 'ada@example.ng',
    },
  };

  it('accepts a correct HMAC-SHA512 over the raw body, rejects otherwise', () => {
    const b = raw(body);
    expect(
      adapter.verify(b, {
        'x-interswitch-signature': hmac('sha512', 'isw-secret', b),
      }),
    ).toBe(true);
    expect(adapter.verify(b, { 'x-interswitch-signature': 'nope' })).toBe(
      false,
    );
    expect(adapter.verify(b, {})).toBe(false);
    expect(
      new InterswitchAdapter(cfg({})).verify(b, {
        'x-interswitch-signature': hmac('sha512', '', b),
      }),
    ).toBe(false);
  });

  it('parses an approved transaction (responseCode 00) and reads the email', () => {
    expect(adapter.parse(body)).toMatchObject({
      provider: 'interswitch',
      providerEventId: 'evt-1',
      reference: 'mref-1',
      amount: 12000,
      currency: 'NGN',
      email: 'ada@example.ng',
    });
  });

  it('ignores declined transactions and other events', () => {
    expect(
      adapter.parse({ ...body, data: { ...body.data, responseCode: '51' } }),
    ).toBeNull();
    expect(adapter.parse({ ...body, event: 'INVOICE.CREATED' })).toBeNull();
  });

  it('does not mislabel a non-naira currency as NGN', () => {
    expect(
      adapter.parse({ ...body, data: { ...body.data, currencyCode: '840' } })
        ?.currency,
    ).toBe('840');
  });
});
