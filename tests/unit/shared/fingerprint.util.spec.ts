// tests/unit/shared/fingerprint.util.spec.ts
import {
  dedupSourceEntity,
  generateEventFingerprint,
  // generateNotificationFingerprint,
  generateIdempotencyKey,
} from '../../../src/shared/utils/fingerprint.util';

import {
  maskPhone,
  maskEmail,
  sanitizeForLog,
} from '@shared/utils/pii-masker.util';

describe('generateEventFingerprint', () => {
  it('should return consistent fingerprint for same inputs in same window', () => {
    const fp1 = generateEventFingerprint('MKTX-001', 'RELIANCE');
    const fp2 = generateEventFingerprint('MKTX-001', 'RELIANCE');
    expect(fp1).toBe(fp2);
  });

  it('should return different fingerprints for different event types', () => {
    const fp1 = generateEventFingerprint('MKTX-001', 'RELIANCE');
    const fp2 = generateEventFingerprint('MKTX-002', 'RELIANCE');
    expect(fp1).not.toBe(fp2);
  });

  it('should return different fingerprints for different entities', () => {
    const fp1 = generateEventFingerprint('MKTX-001', 'RELIANCE');
    const fp2 = generateEventFingerprint('MKTX-001', 'INFY');
    expect(fp1).not.toBe(fp2);
  });

  it('should return a 64-character hex string', () => {
    const fp = generateEventFingerprint('MKTX-001', 'RELIANCE');
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('generateIdempotencyKey', () => {
  it('should return consistent key for same inputs', () => {
    const k1 = generateIdempotencyKey('user-1', 'RISK-001', 'evt-1');
    const k2 = generateIdempotencyKey('user-1', 'RISK-001', 'evt-1');
    expect(k1).toBe(k2);
  });

  it('should return different keys for different users', () => {
    const k1 = generateIdempotencyKey('user-1', 'RISK-001', 'evt-1');
    const k2 = generateIdempotencyKey('user-2', 'RISK-001', 'evt-1');
    expect(k1).not.toBe(k2);
  });
});

describe('maskPhone', () => {
  it('should mask Indian mobile number', () => {
    const masked = maskPhone('+919876543210');
    expect(masked).toBe('+91XXXX3210');
  });

  it('should handle short phone numbers', () => {
    expect(maskPhone('123')).toBe('***');
  });

  it('should handle empty string', () => {
    expect(maskPhone('')).toBe('***');
  });
});

describe('maskEmail', () => {
  it('should mask email address', () => {
    const masked = maskEmail('rahul@example.com');
    expect(masked).toBe('r***@example.com');
  });

  it('should handle invalid email', () => {
    expect(maskEmail('notanemail')).toBe('***@***.***');
  });

  it('should handle single character local part', () => {
    const masked = maskEmail('r@example.com');
    expect(masked).toContain('@example.com');
  });
});

describe('sanitizeForLog', () => {
  it('should redact phone number field', () => {
    const obj = { userId: '123', phone: '+919876543210', amount: 1000 };
    const sanitized = sanitizeForLog(obj);
    expect(sanitized['phone']).toBe('[REDACTED]');
    expect(sanitized['userId']).toBe('123');
    expect(sanitized['amount']).toBe(1000);
  });

  it('should redact email field', () => {
    const obj = { email: 'user@example.com', name: 'Test' };
    const sanitized = sanitizeForLog(obj);
    expect(sanitized['email']).toBe('[REDACTED]');
    expect(sanitized['name']).toBe('Test');
  });

  it('should redact nested PII fields', () => {
    const obj = {
      user: { phone: '+91987', email: 'test@test.com' },
      amount: 500,
    };
    const sanitized = sanitizeForLog(obj) as Record<
      string,
      Record<string, unknown>
    >;
    expect(sanitized['user']?.['phone']).toBe('[REDACTED]');
    expect(sanitized['user']?.['email']).toBe('[REDACTED]');
    expect(sanitized['amount']).toBe(500);
  });

  it('should redact password field', () => {
    const obj = { username: 'admin', password: 'secret123' };
    const sanitized = sanitizeForLog(obj);
    expect(sanitized['password']).toBe('[REDACTED]');
    expect(sanitized['username']).toBe('admin');
  });

  it('should not modify non-PII fields', () => {
    const obj = { eventType: 'RISK-001', priority: 1, status: 'SENT' };
    const sanitized = sanitizeForLog(obj);
    expect(sanitized).toEqual(obj);
  });

  it('should handle empty object', () => {
    expect(sanitizeForLog({})).toEqual({});
  });
});

describe('dedupSourceEntity', () => {
  it('uses the symbol so 500 duplicate price alerts for one user collapse', () => {
    expect(dedupSourceEntity('u1', { symbol: 'RELIANCE' }, 'EVT-1')).toBe(
      'u1:RELIANCE',
    );
    expect(dedupSourceEntity('u1', { symbol: 'RELIANCE' }, 'EVT-2')).toBe(
      'u1:RELIANCE',
    );
  });

  it('is scoped per user', () => {
    expect(dedupSourceEntity('u1', { symbol: 'X' }, 'e')).not.toBe(
      dedupSourceEntity('u2', { symbol: 'X' }, 'e'),
    );
  });

  it('prefers order id, then payment reference', () => {
    expect(
      dedupSourceEntity('u', { order_id: 'O-1', reference: 'R' }, 'e'),
    ).toBe('u:O-1');
    expect(dedupSourceEntity('u', { reference: 'R-9' }, 'e')).toBe('u:R-9');
  });

  it('falls back to the event id so two distinct events are never merged (two deposits, two margin calls)', () => {
    expect(dedupSourceEntity('u', {}, 'EVT-A')).not.toBe(
      dedupSourceEntity('u', {}, 'EVT-B'),
    );
  });
});
