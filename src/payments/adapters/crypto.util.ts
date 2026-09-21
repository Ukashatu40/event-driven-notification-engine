// src/payments/adapters/crypto.util.ts
import { createHmac, timingSafeEqual } from 'crypto';

/** Constant-time string comparison that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacHex(
  algorithm: 'sha512' | 'sha3-512' | 'sha256',
  secret: string,
  data: string | Buffer,
): string {
  return createHmac(algorithm, secret).update(data).digest('hex');
}

export const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0
    ? v
    : typeof v === 'number'
      ? String(v)
      : undefined;
