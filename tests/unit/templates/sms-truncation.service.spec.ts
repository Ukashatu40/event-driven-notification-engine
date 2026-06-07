// tests/unit/templates/sms-truncation.service.spec.ts
import { SmsTruncationService } from '../../../src/templates/engine/sms-truncation.service';

describe('SmsTruncationService', () => {
  let service: SmsTruncationService;

  beforeEach(() => {
    service = new SmsTruncationService();
  });

  describe('fits', () => {
    it('should return true for message exactly 160 chars', () => {
      const msg = 'A'.repeat(160);
      expect(service.fits(msg)).toBe(true);
    });

    it('should return true for message under 160 chars', () => {
      expect(service.fits('Short message')).toBe(true);
    });

    it('should return false for message over 160 chars', () => {
      const msg = 'A'.repeat(161);
      expect(service.fits(msg)).toBe(false);
    });
  });

  describe('truncate', () => {
    it('should return message unchanged if within limit', () => {
      const msg =
        'MARGIN CALL: Shortfall ₹1,25,000. Add funds now. -WealthBridge';
      expect(service.truncate(msg)).toBe(msg);
    });

    it('should truncate message over 160 chars', () => {
      const msg = 'A'.repeat(200);
      const result = service.truncate(msg);
      expect(result.length).toBeLessThanOrEqual(160);
    });

    it('should append suffix when truncating', () => {
      const msg = 'A'.repeat(200);
      const result = service.truncate(msg);
      expect(result).toContain('App');
    });

    it('should truncate at word boundary where possible', () => {
      const msg =
        'MARGIN CALL WARNING: Your account has a shortfall that requires immediate attention ' +
        'please add funds to your trading account before the deadline to avoid auto square off ' +
        'of your positions in the market today by 12 noon IST. -WealthBridge Notifications';

      const result = service.truncate(msg);
      expect(result.length).toBeLessThanOrEqual(160);
      expect(result).not.toMatch(/\S{20,}/); // no suspiciously long unbroken strings
    });

    it('should handle exactly 160 char message without modification', () => {
      const msg = 'X'.repeat(160);
      expect(service.truncate(msg)).toBe(msg);
      expect(service.truncate(msg).length).toBe(160);
    });
  });

  describe('remaining', () => {
    it('should return correct remaining characters', () => {
      expect(service.remaining('Hello')).toBe(155);
      expect(service.remaining('')).toBe(160);
      expect(service.remaining('A'.repeat(160))).toBe(0);
    });

    it('should return 0 for messages over limit', () => {
      expect(service.remaining('A'.repeat(200))).toBe(0);
    });
  });
});
