// tests/unit/payments/payments.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PaymentsService } from '../../../src/payments/payments.service';
import { NormalizedPayment } from '../../../src/payments/payment.types';

const USER = '11111111-1111-4111-8111-111111111111';

const payment = (over: Partial<NormalizedPayment> = {}): NormalizedPayment => ({
  provider: 'paystack',
  providerEventId: 'evt-1',
  reference: 'ref-1',
  amount: 5000,
  currency: 'NGN',
  userId: USER,
  ...over,
});

describe('PaymentsService', () => {
  const adapter = (name: string) => ({
    provider: name,
    displayName: name === 'paystack' ? 'Paystack' : name,
    verify: jest.fn().mockReturnValue(true),
    parse: jest.fn(),
  });
  const paystack = adapter('paystack');
  const findUnique = jest.fn();
  const prisma = { user: { findUnique } };
  const pii = { emailHash: jest.fn((e: string) => `hash(${e})`) };
  const events = { ingest: jest.fn() };
  let service: PaymentsService;

  beforeEach(() => {
    jest.resetAllMocks();
    paystack.verify.mockReturnValue(true);
    events.ingest.mockResolvedValue({
      notification_id: 'ntf-1',
      event_id: 'PAY-paystack-ref-1',
    });
    pii.emailHash.mockImplementation((e: string) => `hash(${e})`);
    service = new PaymentsService(
      paystack as never,
      adapter('flutterwave') as never,
      adapter('opay') as never,
      adapter('interswitch') as never,
      prisma as never,
      pii as never,
      events as never,
    );
  });

  const call = (headers = {}) =>
    service.handle('paystack', Buffer.from('{}'), headers, {});

  it('rejects an unknown provider', async () => {
    await expect(
      service.handle('stripe', Buffer.from('{}'), {}, {}),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects a bad signature with 401 and never parses or ingests', async () => {
    paystack.verify.mockReturnValue(false);
    await expect(call()).rejects.toThrow(UnauthorizedException);
    expect(paystack.parse).not.toHaveBeenCalled();
    expect(events.ingest).not.toHaveBeenCalled();
  });

  it('acknowledges but ignores events that are not successful payments', async () => {
    paystack.parse.mockReturnValue(null);
    expect(await call()).toEqual({
      status: 'ignored',
      reason: 'not_a_successful_payment',
    });
    expect(events.ingest).not.toHaveBeenCalled();
  });

  it('ignores non-NGN payments instead of announcing them in naira', async () => {
    paystack.parse.mockReturnValue(payment({ currency: 'USD' }));
    expect(await call()).toEqual({
      status: 'ignored',
      reason: 'unsupported_currency',
    });
  });

  it('raises TXNX-005 for a successful payment, with an idempotency key from the provider event id', async () => {
    paystack.parse.mockReturnValue(payment());
    findUnique.mockResolvedValue({ id: USER });

    const r = await call();

    expect(r).toMatchObject({ status: 'accepted', notification_id: 'ntf-1' });
    expect(events.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TXNX-005',
        userId: USER,
        priority: 2,
        sourceSystem: 'paystack',
        idempotencyKey: 'payment:paystack:evt-1',
        payload: {
          amount: 5000,
          source: 'Paystack',
          currency: 'NGN',
          reference: 'ref-1',
        },
      }),
    );
  });

  it('falls back to the email blind index when metadata has no user id', async () => {
    paystack.parse.mockReturnValue(
      payment({ userId: undefined, email: 'ada@example.ng' }),
    );
    findUnique.mockResolvedValue({ id: USER });

    await call();

    expect(findUnique).toHaveBeenCalledWith({
      where: { emailHash: 'hash(ada@example.ng)' },
      select: { id: true },
    });
    expect(events.ingest).toHaveBeenCalledTimes(1);
  });

  it('does not trust a non-UUID user id from metadata', async () => {
    paystack.parse.mockReturnValue(
      payment({ userId: "1' OR '1'='1", email: undefined }),
    );
    expect(await call()).toEqual({
      status: 'ignored',
      reason: 'user_not_found',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('acknowledges (does not retry) a payment for an unknown user', async () => {
    paystack.parse.mockReturnValue(payment());
    findUnique.mockResolvedValue(null);
    expect(await call()).toEqual({
      status: 'ignored',
      reason: 'user_not_found',
    });
    expect(events.ingest).not.toHaveBeenCalled();
  });

  it('propagates an ingestion failure so the provider retries', async () => {
    paystack.parse.mockReturnValue(payment());
    findUnique.mockResolvedValue({ id: USER });
    events.ingest.mockRejectedValue(new Error('Event bus unavailable'));
    await expect(call()).rejects.toThrow('Event bus unavailable');
  });
});
