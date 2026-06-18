// src/templates/engine/ab-testing.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { AbTestingService } from './ab-testing.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

describe('AbTestingService', () => {
  let service: AbTestingService;
  let prisma: { template: { findMany: jest.Mock } };
  let redisClient: {
    sadd: jest.Mock;
    expire: jest.Mock;
    incr: jest.Mock;
    scard: jest.Mock;
  };
  let redis: { getClient: jest.Mock; get: jest.Mock };

  beforeEach(async () => {
    prisma = { template: { findMany: jest.fn() } };
    redisClient = {
      sadd: jest.fn(),
      expire: jest.fn(),
      incr: jest.fn(),
      scard: jest.fn(),
    };
    redis = {
      getClient: jest.fn().mockReturnValue(redisClient),
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AbTestingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(AbTestingService);
  });

  describe('resolveVariant', () => {
    it('returns the control template when no AB variants are active', async () => {
      prisma.template.findMany.mockResolvedValue([
        { id: 'RISK-001-v1', version: 1, isAbVariant: false, abWeight: 100 },
      ]);

      const result = await service.resolveVariant('user-1', 'RISK-001');

      expect(result.templateId).toBe('RISK-001-v1');
      expect(result.isAbVariant).toBe(false);
      expect(result.abWeight).toBe(100);
    });

    it('throws when no active template exists for the event type', async () => {
      prisma.template.findMany.mockResolvedValue([]);

      await expect(
        service.resolveVariant('user-1', 'UNKNOWN-001'),
      ).rejects.toThrow('No active template found for event type UNKNOWN-001');
    });

    it('deterministically assigns the same user to the same variant on repeat calls', async () => {
      prisma.template.findMany.mockResolvedValue([
        { id: 'RISK-001-v1', version: 1, isAbVariant: false, abWeight: 100 },
        { id: 'RISK-001-v2', version: 2, isAbVariant: true, abWeight: 50 },
      ]);

      const first = await service.resolveVariant('user-42', 'RISK-001');
      const second = await service.resolveVariant('user-42', 'RISK-001');

      expect(first.templateId).toBe(second.templateId);
    });

    it('assigns different users across both control and variant given enough samples', async () => {
      prisma.template.findMany.mockResolvedValue([
        { id: 'RISK-001-v1', version: 1, isAbVariant: false, abWeight: 100 },
        { id: 'RISK-001-v2', version: 2, isAbVariant: true, abWeight: 50 },
      ]);

      const assignments = new Set<boolean>();
      for (let i = 0; i < 50; i++) {
        const result = await service.resolveVariant(`user-${i}`, 'RISK-001');
        assignments.add(result.isAbVariant);
      }

      // With 50 users and a 50% weighted variant, both branches should appear
      expect(assignments.size).toBe(2);
    });
  });

  describe('recordExposure', () => {
    it('adds the user to the exposure set and sets a 90-day TTL', async () => {
      await service.recordExposure(
        'user-1',
        'RISK-001',
        'RISK-001-v1',
        'notif-1',
      );

      expect(redisClient.sadd).toHaveBeenCalledWith(
        'ab:exposure:RISK-001:RISK-001-v1',
        'user-1:notif-1',
      );
      expect(redisClient.expire).toHaveBeenCalledWith(
        'ab:exposure:RISK-001:RISK-001-v1',
        90 * 24 * 60 * 60,
      );
    });
  });

  describe('recordConversion', () => {
    it('increments the conversion counter for the given type', async () => {
      await service.recordConversion('RISK-001', 'RISK-001-v1', 'delivered');

      expect(redisClient.incr).toHaveBeenCalledWith(
        'ab:conversion:RISK-001:RISK-001-v1:delivered',
      );
    });
  });

  describe('getVariantPerformance', () => {
    it('computes delivery and read rates from raw counters', async () => {
      prisma.template.findMany.mockResolvedValue([
        { id: 'RISK-001-v1', version: 1, isAbVariant: false },
      ]);
      redisClient.scard.mockResolvedValue(100);
      redis.get
        .mockResolvedValueOnce('80') // delivered
        .mockResolvedValueOnce('40'); // read

      const result = await service.getVariantPerformance('RISK-001');

      expect(result[0]).toMatchObject({
        exposures: 100,
        delivered: 80,
        read: 40,
        deliveryRate: 0.8,
        readRate: 0.5,
      });
    });

    it('returns zero rates when there are no exposures', async () => {
      prisma.template.findMany.mockResolvedValue([
        { id: 'RISK-001-v1', version: 1, isAbVariant: false },
      ]);
      redisClient.scard.mockResolvedValue(0);
      redis.get.mockResolvedValue(null);

      const result = await service.getVariantPerformance('RISK-001');

      expect(result[0]!.deliveryRate).toBe(0);
      expect(result[0]!.readRate).toBe(0);
    });
  });
});
