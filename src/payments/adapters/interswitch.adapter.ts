// src/payments/adapters/interswitch.adapter.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NormalizedPayment, PaymentWebhookAdapter } from '../payment.types';
import { asRecord, asString, hmacHex, safeEqual } from './crypto.util';

/**
 * Interswitch: `X-Interswitch-Signature` = HMAC-SHA512 (hex) of the raw JSON
 * body keyed with the merchant secret. Event `TRANSACTION.COMPLETED`; a payment
 * succeeded when `data.responseCode === "00"`. Interswitch retries up to 5
 * times on non-200, so we answer 200 quickly and dedupe by the event `uuid`.
 *
 * ASSUMPTION TO CONFIRM against your Interswitch merchant account:
 * `data.amount` is treated as kobo (minor units). The customer is identified by
 * `data.merchantCustomerId` when it is an email address.
 */
@Injectable()
export class InterswitchAdapter implements PaymentWebhookAdapter {
  readonly provider = 'interswitch' as const;
  readonly displayName = 'Interswitch';

  constructor(private readonly config: ConfigService) {}

  verify(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const secret = this.config.get<string>('INTERSWITCH_SECRET_KEY');
    const received = headers['x-interswitch-signature'];
    if (!secret || !received) return false;
    return safeEqual(received, hmacHex('sha512', secret, rawBody));
  }

  parse(body: Record<string, unknown>): NormalizedPayment | null {
    if (body['event'] !== 'TRANSACTION.COMPLETED') return null;
    const data = asRecord(body['data']);
    if (data['responseCode'] !== '00') return null;

    const id = asString(body['uuid']);
    const reference =
      asString(data['merchantReference']) ?? asString(data['paymentReference']);
    const kobo = Number(data['amount']);
    if (!id || !reference || !Number.isFinite(kobo)) return null;

    // ISO 4217 numeric 566 = NGN; anything else is passed through as-is so the
    // service can reject it rather than mislabel it as naira.
    const code = asString(data['currencyCode']);
    const customer = asString(data['merchantCustomerId']);
    return {
      provider: this.provider,
      providerEventId: id,
      reference,
      amount: kobo / 100,
      currency: !code || code === '566' ? 'NGN' : code,
      email: customer?.includes('@') ? customer : undefined,
    };
  }
}
