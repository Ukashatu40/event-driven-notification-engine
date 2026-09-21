// src/payments/adapters/opay.adapter.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NormalizedPayment, PaymentWebhookAdapter } from '../payment.types';
import { asRecord, asString, hmacHex, safeEqual } from './crypto.util';

/**
 * OPay: the signature travels INSIDE the body as `sha512` and is an
 * HMAC-SHA3-512 (hex) keyed with the merchant private key, computed over a
 * fixed-format string of selected payload fields (not the raw body):
 *
 *   {Amount:"…",Currency:"…",Reference:"…",Refunded:t|f,Status:"…",
 *    Timestamp:"…",Token:"…",TransactionID:"…"}
 *
 * Verification therefore needs the parsed body. Event `type: "transaction-status"`
 * with `payload.status === "SUCCESS"`.
 *
 * ASSUMPTION TO CONFIRM against your OPay merchant account: `payload.amount` is
 * treated as kobo (minor units). Payments are attributed to a user through the
 * reference, which must be created as `<userId>:<anything>` at checkout.
 */
@Injectable()
export class OpayAdapter implements PaymentWebhookAdapter {
  readonly provider = 'opay' as const;
  readonly displayName = 'OPay';

  constructor(private readonly config: ConfigService) {}

  /** Builds the exact string OPay signs. Exposed for tests. */
  static signingString(payload: Record<string, unknown>): string {
    const s = (v: unknown): string => String(v ?? '');
    const refunded = payload['refunded'] === true ? 't' : 'f';
    return (
      `{Amount:"${s(payload['amount'])}",Currency:"${s(payload['currency'])}",` +
      `Reference:"${s(payload['reference'])}",Refunded:${refunded},` +
      `Status:"${s(payload['status'])}",Timestamp:"${s(payload['timestamp'])}",` +
      `Token:"${s(payload['token'])}",TransactionID:"${s(payload['transactionId'])}"}`
    );
  }

  // The OPay signature is over payload fields, so the raw bytes are not needed —
  // the body is passed to verify via the headers-independent parse step.
  verify(
    rawBody: Buffer,
    _headers: Record<string, string | undefined>,
  ): boolean {
    const secret = this.config.get<string>('OPAY_SECRET_KEY');
    if (!secret) return false;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return false;
    }
    const received = asString(body['sha512']);
    if (!received) return false;

    const expected = hmacHex(
      'sha3-512',
      secret,
      OpayAdapter.signingString(asRecord(body['payload'])),
    );
    return safeEqual(received, expected);
  }

  parse(body: Record<string, unknown>): NormalizedPayment | null {
    if (body['type'] !== 'transaction-status') return null;
    const payload = asRecord(body['payload']);
    if (payload['status'] !== 'SUCCESS') return null;

    const id = asString(payload['transactionId']);
    const reference = asString(payload['reference']);
    const kobo = Number(payload['amount']);
    if (!id || !reference || !Number.isFinite(kobo)) return null;

    // Reference convention "<userId>:<suffix>" carries the user id.
    const [maybeUserId] = reference.split(':');
    return {
      provider: this.provider,
      providerEventId: id,
      reference,
      amount: kobo / 100,
      currency: asString(payload['currency']) ?? 'NGN',
      userId: reference.includes(':') ? maybeUserId : undefined,
    };
  }
}
