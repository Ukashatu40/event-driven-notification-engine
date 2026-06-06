// src/shared/utils/pii-masker.util.ts

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
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

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, 'notification-engine-salt', KEY_LENGTH);
}

export function encryptPii(
  plaintext: string,
  secret: string = process.env.JWT_SECRET ?? 'fallback-dev-secret',
): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted (all base64)
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptPii(
  ciphertext: string,
  secret: string = process.env.JWT_SECRET ?? 'fallback-dev-secret',
): string {
  const [ivB64, authTagB64, encryptedB64] = ciphertext.split(':');

  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error('Invalid ciphertext format');
  }

  const key = deriveKey(secret);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
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
