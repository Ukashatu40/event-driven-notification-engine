// tests/unit/delivery/circuit-breaker.service.spec.ts
// Mock PrismaService before any imports to avoid @prisma/client being required
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { CircuitBreakerService } from '../../../src/delivery/circuit-breaker/circuit-breaker.service';
import { RedisService } from '../../../src/infrastructure/redis/redis.service';
import { PrismaService } from '../../../src/infrastructure/database/prisma.service';
import { PrometheusService } from '../../../src/health/prometheus/prometheus.service';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  increment: jest.fn(),
} as unknown as RedisService;

// Cast to any to avoid Prisma generated-type errors (client is generated at runtime)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrismaRaw: any = {
  providerHealth: {
    upsert: jest.fn(),
  },
};
const mockPrisma = mockPrismaRaw as unknown as PrismaService;

const mockPrometheus = {
  setCircuitState: jest.fn(),
} as unknown as PrometheusService;

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CircuitBreakerService(mockRedis, mockPrisma, mockPrometheus);
  });

  describe('allowRequest', () => {
    it('should allow request when circuit is CLOSED', async () => {
      jest.mocked(mockRedis.get).mockResolvedValueOnce('CLOSED');

      const result = await service.allowRequest('msg91');
      expect(result).toBe(true);
    });

    it('should block request when circuit is OPEN and within open duration', async () => {
      jest
        .mocked(mockRedis.get)
        .mockResolvedValueOnce('OPEN') // state
        .mockResolvedValueOnce(String(Date.now() - 10_000)); // last attempt 10s ago

      const result = await service.allowRequest('msg91');
      expect(result).toBe(false);
    });

    it('should allow probe when circuit is OPEN and duration has elapsed', async () => {
      jest
        .mocked(mockRedis.get)
        .mockResolvedValueOnce('OPEN') // state
        .mockResolvedValueOnce(String(Date.now() - 120_000)) // 2 min ago > 60s threshold
        .mockResolvedValueOnce('OPEN'); // for transition check
      jest.mocked(mockRedis.set).mockResolvedValue(undefined);
      jest.mocked(mockPrismaRaw.providerHealth.upsert).mockResolvedValue({});

      const result = await service.allowRequest('msg91');
      expect(result).toBe(true);
    });

    it('should allow request when circuit is HALF_OPEN', async () => {
      jest.mocked(mockRedis.get).mockResolvedValueOnce('HALF_OPEN');

      const result = await service.allowRequest('msg91');
      expect(result).toBe(true);
    });
  });

  describe('recordFailure', () => {
    it('should open circuit after threshold failures', async () => {
      jest.mocked(mockRedis.get).mockResolvedValue('CLOSED');
      jest.mocked(mockRedis.increment).mockResolvedValue(5); // threshold reached
      jest.mocked(mockRedis.set).mockResolvedValue(undefined);
      jest.mocked(mockPrismaRaw.providerHealth.upsert).mockResolvedValue({});

      await service.recordFailure('msg91');

      expect(mockPrometheus.setCircuitState).toHaveBeenCalledWith(
        'msg91',
        expect.any(String),
        'OPEN',
      );
    });

    it('should not open circuit before threshold', async () => {
      jest.mocked(mockRedis.get).mockResolvedValue('CLOSED');
      jest.mocked(mockRedis.increment).mockResolvedValue(3); // below threshold of 5

      await service.recordFailure('msg91');

      expect(mockPrometheus.setCircuitState).not.toHaveBeenCalled();
    });
  });

  describe('recordSuccess', () => {
    it('should close circuit after success threshold in HALF_OPEN', async () => {
      jest.mocked(mockRedis.get).mockResolvedValue('HALF_OPEN');
      jest.mocked(mockRedis.increment).mockResolvedValue(2); // meets success threshold
      jest.mocked(mockRedis.del).mockResolvedValue(undefined);
      jest.mocked(mockRedis.set).mockResolvedValue(undefined);
      jest.mocked(mockPrismaRaw.providerHealth.upsert).mockResolvedValue({});

      await service.recordSuccess('msg91');

      expect(mockPrometheus.setCircuitState).toHaveBeenCalledWith(
        'msg91',
        expect.any(String),
        'CLOSED',
      );
    });

    it('should reset failure counter on success in CLOSED state', async () => {
      jest.mocked(mockRedis.get).mockResolvedValue('CLOSED');

      await service.recordSuccess('msg91');

      expect(mockRedis.del).toHaveBeenCalled();
    });
  });
});
