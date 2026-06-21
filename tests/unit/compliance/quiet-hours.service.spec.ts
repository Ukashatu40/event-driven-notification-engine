// tests/unit/compliance/quiet-hours.service.spec.ts
// Mock PrismaService before any imports to avoid @prisma/client being required
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { QuietHoursService } from '../../../src/compliance/quiet-hours/quiet-hours.service';
import { RedisService } from '../../../src/infrastructure/redis/redis.service';
import { PrismaService } from '../../../src/infrastructure/database/prisma.service';

const mockRedis = {
  zadd: jest.fn(),
  zrangebyscore: jest.fn(),
  zrem: jest.fn(),
  zcount: jest.fn(),
} as unknown as RedisService;

// Cast to any to avoid Prisma generated-type errors (client is generated at runtime)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrismaRaw: any = {
  user: {
    findUnique: jest.fn(),
  },
};
const mockPrisma = mockPrismaRaw as unknown as PrismaService;

describe('QuietHoursService', () => {
  let service: QuietHoursService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QuietHoursService(mockRedis, mockPrisma);
  });

  describe('check — CRITICAL bypass', () => {
    it('should not suppress RISK-001 during quiet hours', async () => {
      const result = await service.check('user-123', 'RISK-001');
      expect(result.suppressed).toBe(false);
      expect(mockPrismaRaw.user.findUnique).not.toHaveBeenCalled();
    });

    it('should not suppress RISK-002 during quiet hours', async () => {
      const result = await service.check('user-123', 'RISK-002');
      expect(result.suppressed).toBe(false);
    });

    it('should not suppress MKTX-002 during quiet hours', async () => {
      const result = await service.check('user-123', 'MKTX-002');
      expect(result.suppressed).toBe(false);
    });
  });

  describe('check — user not found', () => {
    it('should not suppress if user not found', async () => {
      jest.mocked(mockPrismaRaw.user.findUnique).mockResolvedValueOnce(null);

      const result = await service.check('user-999', 'SIPX-001');
      expect(result.suppressed).toBe(false);
    });
  });

  describe('shouldBatchIntoDigest', () => {
    it('should return true when queue depth >= 5', () => {
      expect(service.shouldBatchIntoDig(5)).toBe(true);
      expect(service.shouldBatchIntoDig(10)).toBe(true);
    });

    it('should return false when queue depth < 5', () => {
      expect(service.shouldBatchIntoDig(0)).toBe(false);
      expect(service.shouldBatchIntoDig(4)).toBe(false);
    });
  });

  describe('queue', () => {
    it('should queue notification with correct delivery timestamp', async () => {
      jest.mocked(mockRedis.zadd).mockResolvedValueOnce(undefined);
      const deliverAt = new Date(Date.now() + 3_600_000);

      await service.queue('user-123', 'notif-456', deliverAt);

      expect(mockRedis.zadd).toHaveBeenCalledWith(
        expect.stringContaining('user-123'),
        deliverAt.getTime(),
        'notif-456',
      );
    });
  });
});
