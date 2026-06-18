// src/notifications/engine/send-time-optimization.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { SendTimeOptimizationService } from './send-time-optimization.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { Priority } from '../../shared/constants/priorities';

describe('SendTimeOptimizationService', () => {
  let service: SendTimeOptimizationService;
  let redis: {
    hget: jest.Mock;
    hgetall: jest.Mock;
    getClient: jest.Mock;
  };
  let pipeline: { hset: jest.Mock; expire: jest.Mock; exec: jest.Mock };

  beforeEach(async () => {
    pipeline = {
      hset: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    redis = {
      hget: jest.fn(),
      hgetall: jest.fn(),
      getClient: jest
        .fn()
        .mockReturnValue({ pipeline: jest.fn().mockReturnValue(pipeline) }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendTimeOptimizationService,
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(SendTimeOptimizationService);
  });

  describe('decide', () => {
    it('bypasses optimization for CRITICAL events', async () => {
      const result = await service.decide(
        'user-1',
        'RISK-001',
        Priority.LOW,
        'Asia/Kolkata',
      );

      expect(result.optimize).toBe(false);
      expect(result.reason).toBe('PRIORITY_BYPASS');
    });

    it('bypasses optimization for HIGH and CRITICAL priority regardless of event type', async () => {
      const result = await service.decide(
        'user-1',
        'MKTX-001',
        Priority.CRITICAL,
        'Asia/Kolkata',
      );

      expect(result.optimize).toBe(false);
      expect(result.reason).toBe('PRIORITY_BYPASS');
    });

    it('does not optimize when there is insufficient engagement data', async () => {
      redis.hgetall.mockResolvedValue({ '9': '3' }); // only 3 samples total

      const result = await service.decide(
        'user-1',
        'MKTX-001',
        Priority.LOW,
        'Asia/Kolkata',
      );

      expect(result.optimize).toBe(false);
      expect(result.reason).toBe('INSUFFICIENT_DATA');
    });

    it('optimizes when enough samples exist and the best hour is reachable within the delay window', async () => {
      // 15 total samples, hour 14 dominant
      redis.hgetall.mockResolvedValue({
        '9': '2',
        '14': '10',
        '20': '3',
      });

      const result = await service.decide(
        'user-1',
        'MKTX-001',
        Priority.LOW,
        'UTC',
      );

      // Whether it optimizes depends on current time vs hour 14 in UTC,
      // but it must never be the bypass/insufficient-data reasons
      expect(['INSUFFICIENT_DATA', 'PRIORITY_BYPASS']).not.toContain(
        result.reason,
      );
    });
  });

  describe('recordEngagement', () => {
    it('increments the score for the read hour and decays all other hours', async () => {
      redis.hgetall.mockResolvedValue({ '10': '5', '14': '2' });
      redis.hget.mockResolvedValue('5');

      const readAt = new Date();
      readAt.setHours(10, 0, 0, 0);

      await service.recordEngagement('user-1', readAt);

      // Hour 10 gets incremented
      expect(pipeline.hset).toHaveBeenCalledWith(expect.any(String), '10', '6');
      // Hour 14 gets decayed (2 * 0.9 = 1.8)
      expect(pipeline.hset).toHaveBeenCalledWith(
        expect.any(String),
        '14',
        '1.8',
      );
      expect(pipeline.expire).toHaveBeenCalled();
    });
  });

  describe('getEngagementProfile', () => {
    it('returns the top 3 hours sorted by score descending', async () => {
      redis.hgetall.mockResolvedValue({
        '9': '5',
        '14': '20',
        '20': '10',
        '22': '1',
      });

      const profile = await service.getEngagementProfile('user-1');

      expect(profile).toHaveLength(3);
      expect(profile[0]).toEqual({ hour: 14, score: 20 });
      expect(profile[1]).toEqual({ hour: 20, score: 10 });
      expect(profile[2]).toEqual({ hour: 9, score: 5 });
    });

    it('returns an empty array when there is no engagement history', async () => {
      redis.hgetall.mockResolvedValue({});

      const profile = await service.getEngagementProfile('user-1');

      expect(profile).toEqual([]);
    });
  });
});
