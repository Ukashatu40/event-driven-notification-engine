// tests/unit/infrastructure/kafka-lag.spec.ts
import { KafkaLagMonitorService } from '../../../src/infrastructure/kafka/kafka-lag-monitor.service';
import { KafkaService } from '../../../src/infrastructure/kafka/kafka.service';

describe('Kafka consumer lag', () => {
  describe('KafkaService.getConsumerLag', () => {
    const build = (end: unknown[], committed: unknown[]) => {
      const svc = Object.create(KafkaService.prototype) as KafkaService;
      (svc as unknown as { admin: unknown }).admin = {
        fetchTopicOffsets: jest.fn().mockResolvedValue(end),
        fetchOffsets: jest.fn().mockResolvedValue([{ partitions: committed }]),
      };
      return svc;
    };

    it('is log-end offset minus committed offset, per partition', async () => {
      const svc = build(
        [
          { partition: 0, offset: '1000', low: '0' },
          { partition: 1, offset: '500', low: '0' },
        ],
        [
          { partition: 0, offset: '900' },
          { partition: 1, offset: '500' },
        ],
      );
      expect(await svc.getConsumerLag('g', 't')).toEqual([
        { partition: 0, lag: 100 },
        { partition: 1, lag: 0 },
      ]);
    });

    it('counts a never-committed partition as lag from the start of the log', async () => {
      const svc = build(
        [{ partition: 0, offset: '300', low: '100' }],
        [{ partition: 0, offset: '-1' }],
      );
      expect(await svc.getConsumerLag('g', 't')).toEqual([
        { partition: 0, lag: 200 },
      ]);
    });

    it('never reports negative lag', async () => {
      const svc = build(
        [{ partition: 0, offset: '10', low: '0' }],
        [{ partition: 0, offset: '15' }],
      );
      expect((await svc.getConsumerLag('g', 't'))[0].lag).toBe(0);
    });
  });

  describe('KafkaLagMonitorService.sample', () => {
    const topics = {
      critical: 'notification-critical',
      events: 'notification-events',
    };
    const groups = { critical: 'critical-cg', standard: 'standard-cg' };
    const set = jest.fn();
    const config = {
      get: (k: string) =>
        ({ 'kafka.topics': topics, 'kafka.groupIds': groups })[k],
    };

    beforeEach(() => jest.resetAllMocks());

    it('publishes kafka_consumer_lag{topic,partition,consumer_group} for both consumer groups', async () => {
      const kafka = {
        getConsumerLag: jest
          .fn()
          .mockResolvedValue([{ partition: 2, lag: 42 }]),
      };
      const m = new KafkaLagMonitorService(
        kafka as never,
        { kafkaConsumerLag: { set } } as never,
        config as never,
      );
      await m.sample();
      expect(set).toHaveBeenCalledWith(
        {
          topic: 'notification-critical',
          partition: '2',
          consumer_group: 'critical-cg',
        },
        42,
      );
      expect(set).toHaveBeenCalledWith(
        {
          topic: 'notification-events',
          partition: '2',
          consumer_group: 'standard-cg',
        },
        42,
      );
    });

    it('survives a failing admin call and still samples the other group', async () => {
      const kafka = {
        getConsumerLag: jest
          .fn()
          .mockRejectedValueOnce(new Error('broker down'))
          .mockResolvedValue([{ partition: 0, lag: 1 }]),
      };
      const m = new KafkaLagMonitorService(
        kafka as never,
        { kafkaConsumerLag: { set } } as never,
        config as never,
      );
      await expect(m.sample()).resolves.toBeUndefined();
      expect(set).toHaveBeenCalledTimes(1);
    });
  });
});
