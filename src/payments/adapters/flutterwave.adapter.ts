// src/payments/adapters/flutterwave.adapter.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NormalizedPayment, PaymentWebhookAdapter } from '../payment.types';
import { asRecord, asString, safeEqual } from './crypto.util';

/**
 * Flutterwave: NOT a computed signature. You configure a "secret hash" in the
 * dashboard and Flutterwave echoes it verbatim in the `verif-hash` header, so
 * verification is a constant-time equality check against FLUTTERWAVE_SECRET_HASH.
 * Event `charge.completed` with `data.status === "successful"`; `data.amount`
 * is in major units (naira). Send `meta.user_id` when creating the charge.
 */
@Injectable()
export class FlutterwaveAdapter implements PaymentWebhookAdapter {
  readonly provider = 'flutterwave' as const;
  readonly displayName = 'Flutterwave';

  constructor(private readonly config: ConfigService) {}

  verify(
    _rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const secret = this.config.get<string>('FLUTTERWAVE_SECRET_HASH');
    const received = headers['verif-hash'];
    if (!secret || !received) return false;
    return safeEqual(received, secret);
  }

  parse(body: Record<string, unknown>): NormalizedPayment | null {
    if (body['event'] !== 'charge.completed') return null;
    const data = asRecord(body['data']);
    if (data['status'] !== 'successful') return null;

    const id = asString(data['id']);
    const reference = asString(data['tx_ref']);
    const amount = Number(data['amount']);
    if (!id || !reference || !Number.isFinite(amount)) return null;

    return {
      provider: this.provider,
      providerEventId: id,
      reference,
      amount,
      currency: asString(data['currency']) ?? 'NGN',
      userId: asString(asRecord(data['meta'])['user_id']),
      email: asString(asRecord(data['customer'])['email']),
    };
  }
}
