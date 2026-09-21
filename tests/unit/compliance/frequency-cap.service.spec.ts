// tests/unit/compliance/frequency-cap.service.spec.ts
import { FrequencyCapService } from '../../../src/compliance/frequency-cap/frequency-cap.service';
import { RedisService } from '../../../src/infrastructure/redis/redis.service';
import { PrometheusService } from '../../../src/health/prometheus/prometheus.service';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  exists: jest.fn(),
  increment: jest.fn(),
  ttl: jest.fn(),
} as unknown as RedisService;

const mockPrometheus = {
  recordCapHit: jest.fn(),
} as unknown as PrometheusService;

describe('FrequencyCapService', () => {
  let service: FrequencyCapService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FrequencyCapService(mockRedis, mockPrometheus);
  });

  describe('check — CRITICAL events bypass all caps', () => {
    it('should allow RISK-001 regardless of cap state', async () => {
      const result = await service.check('user-123', 'RISK-001', 'sms');

      expect(result.capped).toBe(false);
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should allow RISK-002 regardless of cap state', async () => {
      const result = await service.check('user-123', 'RISK-002', 'push');

      expect(result.capped).toBe(false);
    });

    it('should allow MKTX-002 circuit breaker regardless of cap state', async () => {
      const result = await service.check('user-123', 'MKTX-002', 'sms');

      expect(result.capped).toBe(false);
    });
  });

  describe('check — cooldown enforcement', () => {
    it('should cap notification within cooldown window', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(true);
      jest.mocked(mockRedis.ttl).mockResolvedValueOnce(600);

      const result = await service.check('user-123', 'MKTX-001', 'push');

      expect(result.capped).toBe(true);
      if (result.capped) {
        expect(result.reason).toContain('Cooldown active');
      }
    });

    it('should allow notification after cooldown expires', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(false);
      jest.mocked(mockRedis.get).mockResolvedValue('0');

      const result = await service.check('user-123', 'MKTX-001', 'push');

      expect(result.capped).toBe(false);
    });
  });

  describe('check — category hourly cap', () => {
    it('should cap when category hourly limit reached', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(false);
      jest
        .mocked(mockRedis.get)
        .mockResolvedValueOnce('3') // category hourly = 3 (at limit)
        .mockResolvedValue('0');
      jest.mocked(mockRedis.ttl).mockResolvedValue(1800);

      const result = await service.check('user-123', 'MKTX-001', 'push');

      expect(result.capped).toBe(true);
      if (result.capped) {
        expect(result.reason).toContain('Category hourly cap');
      }
    });

    it('should allow when category hourly count is below limit', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(false);
      jest.mocked(mockRedis.get).mockResolvedValue('1');

      const result = await service.check('user-123', 'MKTX-001', 'push');

      expect(result.capped).toBe(false);
    });
  });

  describe('check — channel daily cap', () => {
    it('should cap SMS when daily limit of 5 is reached', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(false);
      jest
        .mocked(mockRedis.get)
        .mockResolvedValueOnce('0') // category hourly
        .mockResolvedValueOnce('5') // channel daily = 5 (at limit)
        .mockResolvedValue('0');
      jest.mocked(mockRedis.ttl).mockResolvedValue(3600);

      const result = await service.check('user-123', 'SIPX-001', 'sms');

      expect(result.capped).toBe(true);
      if (result.capped) {
        expect(result.reason).toContain('Channel daily cap');
        expect(result.reason).toContain('sms');
      }
    });

    it('should cap push when daily limit of 8 is reached', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(false);
      jest
        .mocked(mockRedis.get)
        .mockResolvedValueOnce('0') // category hourly
        .mockResolvedValueOnce('8') // push daily = 8 (at limit)
        .mockResolvedValue('0');
      jest.mocked(mockRedis.ttl).mockResolvedValue(3600);

      const result = await service.check('user-123', 'SIPX-001', 'push');

      expect(result.capped).toBe(true);
    });
  });

  describe('check — global daily cap', () => {
    it('should cap when global daily limit of 12 is reached', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(false);
      jest
        .mocked(mockRedis.get)
        .mockResolvedValueOnce('0') // category hourly
        .mockResolvedValueOnce('0') // channel daily
        .mockResolvedValueOnce('12'); // global daily = 12 (at limit)
      jest.mocked(mockRedis.ttl).mockResolvedValue(43200);

      const result = await service.check('user-123', 'SIPX-001', 'email');

      expect(result.capped).toBe(true);
      if (result.capped) {
        expect(result.reason).toContain('Global daily cap');
      }
    });

    it('should allow when global daily count is below limit', async () => {
      // exists = false (no cooldown)
      jest.mocked(mockRedis.exists).mockResolvedValueOnce(false);
      // category hourly = 1 (below cap of 3)
      jest.mocked(mockRedis.get).mockResolvedValueOnce('1');
      // channel daily = 1 (below cap)
      jest.mocked(mockRedis.get).mockResolvedValueOnce('1');
      // global daily = 5 (below cap of 12)
      jest.mocked(mockRedis.get).mockResolvedValueOnce('5');

      const result = await service.check('user-123', 'SIPX-001', 'email');

      expect(result.capped).toBe(false);
    });
  });

  describe('record', () => {
    it('should increment all cap counters on record', async () => {
      jest.mocked(mockRedis.increment).mockResolvedValue(1);
      jest.mocked(mockRedis.set).mockResolvedValue(undefined);

      await service.record('user-123', 'MKTX-001', 'push');

      expect(mockRedis.increment).toHaveBeenCalledTimes(3);
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('check — regulator-mandated events are not swallowed as "too frequent"', () => {
    it('a second TXNX-005 deposit alert inside the 15-minute cooldown is NOT capped', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValue(true); // cooldown key present
      jest.mocked(mockRedis.get).mockResolvedValue(null);
      jest.mocked(mockRedis.increment).mockResolvedValue(1);

      const result = await service.check('u1', 'TXNX-005', 'sms');

      expect(result.capped).toBe(false);
      expect(mockRedis.exists).not.toHaveBeenCalled(); // cooldown never consulted
    });

    it('the same cooldown DOES still cap a non-mandated repeat (price alert)', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValue(true);
      jest.mocked(mockRedis.ttl).mockResolvedValue(600);

      const result = await service.check('u1', 'MKTX-001', 'push');

      expect(result.capped).toBe(true);
    });

    it('a mandated event still respects the global daily cap', async () => {
      jest.mocked(mockRedis.exists).mockResolvedValue(false);
      // every counter reports the user is far over
      jest.mocked(mockRedis.get).mockResolvedValue('999');
      jest.mocked(mockRedis.increment).mockResolvedValue(999);

      const result = await service.check('u1', 'TXNX-001', 'sms');

      expect(result.capped).toBe(true);
    });
  });

  describe('record — one event is one notification', () => {
    it('advances every counter for the first channel', async () => {
      await service.record('u1', 'MKTX-001', 'sms');
      expect(mockRedis.increment).toHaveBeenCalledTimes(3); // channel + global + category
      expect(mockRedis.set).toHaveBeenCalledTimes(1); // cooldown
    });

    it('advances only the per-channel counter for further channels of the same event', async () => {
      await service.record('u1', 'MKTX-001', 'push', false);
      expect(mockRedis.increment).toHaveBeenCalledTimes(1);
      expect(mockRedis.increment).toHaveBeenCalledWith(
        expect.stringContaining('channel:push'),
        expect.any(Number),
      );
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });
});
