// tests/unit/shared/pii.spec.ts
import { randomBytes } from 'crypto';
import {
  blindIndex,
  decryptPii,
  encryptPii,
  isEncryptedPii,
  maskEmail,
  maskPhone,
} from '../../../src/shared/utils/pii-masker.util';
import { PiiService } from '../../../src/shared/pii/pii.service';

const KEY = randomBytes(32);
const HEX_KEY = randomBytes(32).toString('hex');
const HASH_KEY = randomBytes(32).toString('hex');

const config = (over: Record<string, string> = {}) =>
  ({
    get: (k: string) =>
      ({ PII_ENCRYPTION_KEY: HEX_KEY, PII_HASH_KEY: HASH_KEY, ...over })[k],
  }) as never;

describe('PII encryption (AES-256-GCM)', () => {
  it('round-trips a value', () => {
    expect(decryptPii(encryptPii('+919876543210', KEY), KEY)).toBe(
      '+919876543210',
    );
  });

  it('round-trips non-ASCII text', () => {
    expect(decryptPii(encryptPii('Ọlá@ẹ.ng', KEY), KEY)).toBe('Ọlá@ẹ.ng');
  });

  it('uses the versioned prefix and never stores the plaintext', () => {
    const c = encryptPii('+919876543210', KEY);
    expect(c.startsWith('enc:v1:')).toBe(true);
    expect(isEncryptedPii(c)).toBe(true);
    expect(c).not.toContain('9876543210');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptPii('same', KEY)).not.toBe(encryptPii('same', KEY));
  });

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    const c = encryptPii('secret', KEY);
    const raw = Buffer.from(c.slice(7), 'base64');
    raw[raw.length - 1] ^= 0x01;
    expect(() => decryptPii('enc:v1:' + raw.toString('base64'), KEY)).toThrow();
  });

  it('rejects the wrong key', () => {
    expect(() =>
      decryptPii(encryptPii('secret', KEY), randomBytes(32)),
    ).toThrow();
  });

  it('rejects a key of the wrong length and a non-encrypted value', () => {
    expect(() => encryptPii('x', Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => decryptPii('plain', KEY)).toThrow(/not in the encrypted/);
    expect(() => decryptPii('enc:v1:AAAA', KEY)).toThrow(/truncated/);
  });

  it('blindIndex is deterministic, keyed, and reveals nothing about the input', () => {
    const a = blindIndex('phone:+919876543210', KEY);
    expect(a).toBe(blindIndex('phone:+919876543210', KEY));
    expect(a).not.toBe(blindIndex('phone:+919876543210', randomBytes(32)));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PiiService', () => {
  const svc = new PiiService(config());

  it('refuses to start without valid keys (no silent fallback secret)', () => {
    expect(() => new PiiService(config({ PII_ENCRYPTION_KEY: '' }))).toThrow(
      /PII_ENCRYPTION_KEY/,
    );
    expect(
      () => new PiiService(config({ PII_ENCRYPTION_KEY: 'abcd' })),
    ).toThrow(/64 hex/);
    expect(() => new PiiService(config({ PII_HASH_KEY: 'short' }))).toThrow(
      /PII_HASH_KEY/,
    );
  });

  it('encrypts and decrypts', () => {
    expect(svc.decrypt(svc.encrypt('user@example.com'))).toBe(
      'user@example.com',
    );
  });

  it('passes legacy plaintext through (rollout window) rather than crashing', () => {
    expect(svc.decrypt('+919876543210')).toBe('+919876543210');
  });

  it('phone hash ignores spaces and dashes', () => {
    expect(svc.phoneHash('+91 98765-43210')).toBe(
      svc.phoneHash('+919876543210'),
    );
  });

  it('email hash is case- and whitespace-insensitive', () => {
    expect(svc.emailHash('  User@Example.COM ')).toBe(
      svc.emailHash('user@example.com'),
    );
  });

  it('phone and email hashes of look-alike values do not collide across kinds', () => {
    expect(svc.phoneHash('123456')).not.toBe(svc.emailHash('123456'));
  });

  it('protectContact returns ciphertext plus blind indexes and no plaintext', () => {
    const out = svc.protectContact({
      phone: '+2348012345678',
      email: 'ada@example.ng',
    });
    expect(out.phone).toMatch(/^enc:v1:/);
    expect(out.email).toMatch(/^enc:v1:/);
    expect(out.phoneHash).toBe(svc.phoneHash('+2348012345678'));
    expect(out.emailHash).toBe(svc.emailHash('ada@example.ng'));
    expect(JSON.stringify(out)).not.toContain('2348012345678');
    expect(JSON.stringify(out)).not.toContain('ada@example.ng');
  });

  it('protectContact only touches the fields it was given', () => {
    expect(
      Object.keys(svc.protectContact({ phone: '+2348012345678' })).sort(),
    ).toEqual(['phone', 'phoneHash']);
  });
});

describe('log masking', () => {
  it('masks phone numbers and emails', () => {
    expect(maskPhone('+919876543210')).toBe('+91XXXX3210');
    expect(maskEmail('sam@example.com')).toBe('s***@example.com');
  });
});
