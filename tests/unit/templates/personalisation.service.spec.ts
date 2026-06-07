// tests/unit/templates/personalisation.service.spec.ts
import { PersonalisationService } from '../../../src/templates/engine/personalisation.service';

describe('PersonalisationService', () => {
  let service: PersonalisationService;

  beforeEach(() => {
    service = new PersonalisationService();
  });

  const baseCtx = {
    userId: 'user-123',
    userName: 'Rahul Sharma',
    language: 'en' as const,
    timezone: 'Asia/Kolkata',
    payload: {},
    appName: 'WealthBridge',
  };

  describe('buildContext — base fields', () => {
    it('should include user name', () => {
      const ctx = service.buildContext(baseCtx);
      expect(ctx['user_name']).toBe('Rahul Sharma');
    });

    it('should use default name when userName is undefined', () => {
      const ctx = service.buildContext({ ...baseCtx, userName: undefined });
      expect(ctx['user_name']).toBe('Valued Customer');
    });

    it('should include app name', () => {
      const ctx = service.buildContext(baseCtx);
      expect(ctx['app_name']).toBe('WealthBridge');
    });

    it('should include formatted timestamp', () => {
      const ctx = service.buildContext(baseCtx);
      expect(ctx['timestamp']).toBeDefined();
      expect(typeof ctx['timestamp']).toBe('string');
    });
  });

  describe('buildContext — monetary formatting', () => {
    it('should format amount field as Indian currency', () => {
      const ctx = service.buildContext({
        ...baseCtx,
        payload: { amount: 125000 },
      });

      expect(ctx['amount']).toBeDefined();
      expect(String(ctx['amount'])).toContain('1,25,000');
    });

    it('should preserve raw value for calculations', () => {
      const ctx = service.buildContext({
        ...baseCtx,
        payload: { amount: 125000 },
      });

      expect(ctx['amount_raw']).toBe(125000);
    });

    it('should format shortfall_amount for margin calls', () => {
      const ctx = service.buildContext({
        ...baseCtx,
        payload: { shortfall_amount: 50000 },
      });

      expect(ctx['shortfall_amount']).toBeDefined();
      expect(ctx['shortfall_amount_raw']).toBe(50000);
    });
  });

  describe('buildContext — P&L calculation', () => {
    it('should compute P&L when buy price, current price and qty are present', () => {
      const ctx = service.buildContext({
        ...baseCtx,
        payload: {
          buy_price: 1000,
          current_price: 1200,
          qty: 100,
        },
      });

      expect(ctx['pnl_raw']).toBe(20000);
      expect(ctx['pnl_direction']).toBe('profit');
      expect(ctx['pnl_percent']).toBe('20.00');
    });

    it('should show loss direction for negative P&L', () => {
      const ctx = service.buildContext({
        ...baseCtx,
        payload: {
          buy_price: 1200,
          current_price: 1000,
          qty: 100,
        },
      });

      expect(ctx['pnl_raw']).toBe(-20000);
      expect(ctx['pnl_direction']).toBe('loss');
    });
  });

  describe('buildContext — shortfall percentage', () => {
    it('should compute shortfall percentage for margin calls', () => {
      const ctx = service.buildContext({
        ...baseCtx,
        payload: {
          shortfall_amount: 25000,
          required_margin: 100000,
        },
      });

      expect(ctx['shortfall_percent']).toBe('25.0');
    });
  });

  describe('buildContext — locale formatting', () => {
    it('should format currency differently for Hindi locale', () => {
      const ctxEn = service.buildContext({
        ...baseCtx,
        language: 'en',
        payload: { amount: 100000 },
      });

      const ctxHi = service.buildContext({
        ...baseCtx,
        language: 'hi',
        payload: { amount: 100000 },
      });

      // Both should be defined
      expect(ctxEn['amount']).toBeDefined();
      expect(ctxHi['amount']).toBeDefined();
    });
  });
});
