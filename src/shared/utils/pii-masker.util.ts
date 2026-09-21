// src/shared/utils/pii-masker.util.ts

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

/**
 * Masks PII for safe logging.
 * Encrypts PII for safe database storage.
 * Never call these with raw PII outside of designated service layers.
 */

// ── Log masking ───────────────────────────────────────────────────

export function maskPhone(phone: string): string {
  if (!phone || phone.length < 6) return '***';
  // +91XXXXXXXXXX → +91XXXX1234
  const last4 = phone.slice(-4);
  const prefix = phone.slice(0, phone.startsWith('+') ? 3 : 2);
  return `${prefix}XXXX${last4}`;
}

export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return '***@***.***';
  const [local, domain] = email.split('@');
  const visibleLocal = local.length > 1 ? local[0] : '*';
  return `${visibleLocal}***@${domain}`;
}

export function maskAccountNumber(account: string): string {
  if (!account || account.length < 4) return '****';
  return `****${account.slice(-4)}`;
}

// ── AES-256-GCM encryption for PII at rest ────────────────────────
//
// Stored format:  enc:v1:<base64( iv(12) | authTag(16) | ciphertext )>
//
// - AES-256-GCM authenticates as well as encrypts: any tampering with the
//   stored value makes decryption throw instead of returning garbage.
// - A fresh random 96-bit IV per value, so identical inputs never produce the
//   same ciphertext (which is why equality lookups use blindIndex() below).
// - The "v1" segment names the key generation, so a rotated key can be added
//   later without rewriting every row at once.
//
// The key is a raw 32-byte Buffer supplied by the caller (from
// PII_ENCRYPTION_KEY) — never derived from another secret, never defaulted.

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const PII_CIPHERTEXT_PREFIX = 'enc:v1:';

export function isEncryptedPii(value: string): boolean {
  return value.startsWith(PII_CIPHERTEXT_PREFIX);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`PII key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

export function encryptPii(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  return PII_CIPHERTEXT_PREFIX + packed.toString('base64');
}

export function decryptPii(stored: string, key: Buffer): string {
  assertKey(key);
  if (!isEncryptedPii(stored)) {
    throw new Error('Value is not in the encrypted PII format');
  }
  const packed = Buffer.from(
    stored.slice(PII_CIPHERTEXT_PREFIX.length),
    'base64',
  );
  if (packed.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('Encrypted PII value is truncated');
  }
  const iv = packed.subarray(0, IV_BYTES);
  const authTag = packed.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const encrypted = packed.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Deterministic keyed hash (HMAC-SHA256, hex) used as a "blind index": it lets
 * the database enforce uniqueness and answer "does this phone/email exist?"
 * without holding the plaintext. Uses a key SEPARATE from the encryption key.
 */
export function blindIndex(normalisedValue: string, key: Buffer): string {
  return createHmac('sha256', key).update(normalisedValue).digest('hex');
}

// ── Object sanitizer — strips PII from log payloads ──────────────

const PII_FIELDS = new Set([
  'phone',
  'phoneNumber',
  'email',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'apiKey',
  'secret',
  'pan',
  'aadhaar',
  'accountNumber',
  'ifsc',
]);

export function sanitizeForLog(
  obj: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 5) return obj; // prevent infinite recursion

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS.has(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      sanitized[key] = sanitizeForLog(
        value as Record<string, unknown>,
        depth + 1,
      );
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
