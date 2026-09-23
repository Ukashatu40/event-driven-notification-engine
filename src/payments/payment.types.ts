// src/payments/payment.types.ts

export type PaymentProviderName =
  | 'paystack'
  | 'flutterwave'
  | 'opay'
  | 'interswitch';

/** A successful inbound payment, normalised across providers. */
export interface NormalizedPayment {
  provider: PaymentProviderName;
  /** Provider-side unique id; drives idempotency so retried webhooks are harmless. */
  providerEventId: string;
  reference: string;
  /** Amount in MAJOR units (naira). */
  amount: number;
  currency: string;
  /** How we find the user: explicit id (from metadata) or the customer's email. */
  userId?: string;
  email?: string;
}

export interface PaymentWebhookAdapter {
  readonly provider: PaymentProviderName;
  /** Human-readable name used in the notification text ("from Paystack"). */
  readonly displayName: string;
  /**
   * Verifies the request really came from the provider. MUST fail closed:
   * returns false when the secret is not configured or the signature is
   * missing/incorrect.
   */
  verify(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  /** Returns a payment for a successful inbound charge, or null for anything else. */
  parse(body: Record<string, unknown>): NormalizedPayment | null;
}
