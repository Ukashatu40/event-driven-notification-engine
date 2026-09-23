// src/payments/adapters/paystack.adapter.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NormalizedPayment, PaymentWebhookAdapter } from '../payment.types';
import { asRecord, asString, hmacHex, safeEqual } from './crypto.util';

/**
 * Paystack: `x-paystack-signature` = HMAC-SHA512 (hex) of the raw request body
 * keyed with the merchant SECRET key. Event `charge.success`; `data.amount` is
 * in kobo. Pass `metadata.user_id` when initialising a transaction so the
 * deposit can be attributed to a user.
 */
@Injectable()
export class PaystackAdapter implements PaymentWebhookAdapter {
  readonly provider = 'paystack' as const;
  readonly displayName = 'Paystack';

  constructor(private readonly config: ConfigService) {}

  verify(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY');
    const received = headers['x-paystack-signature'];
    if (!secret || !received) return false;
    return safeEqual(received, hmacHex('sha512', secret, rawBody));
  }

  parse(body: Record<string, unknown>): NormalizedPayment | null {
    if (body['event'] !== 'charge.success') return null;
    const data = asRecord(body['data']);
    if (data['status'] !== undefined && data['status'] !== 'success')
      return null;

    const id = asString(data['id']);
    const reference = asString(data['reference']);
    const kobo = Number(data['amount']);
    if (!id || !reference || !Number.isFinite(kobo)) return null;

    return {
      provider: this.provider,
      providerEventId: id,
      reference,
      amount: kobo / 100,
      currency: asString(data['currency']) ?? 'NGN',
      userId: asString(asRecord(data['metadata'])['user_id']),
      email: asString(asRecord(data['customer'])['email']),
    };
  }
}
