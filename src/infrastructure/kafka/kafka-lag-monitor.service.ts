// src/infrastructure/kafka/kafka-lag-monitor.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaService } from './kafka.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';

/**
 * Publishes `kafka_consumer_lag{topic,partition,consumer_group}` (spec A11.1).
 * The KafkaConsumerLag alert (lag > 10,000 for 5 minutes) fires on it, so it
 * must be a real measurement, refreshed every 15s.
 */
@Injectable()
export class KafkaLagMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaLagMonitorService.name);
  private handle: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly kafka: KafkaService,
    private readonly prometheus: PrometheusService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('KAFKA_LAG_MONITOR_ENABLED') === 'false')
      return;
    this.handle = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void this.sample().finally(() => {
        this.polling = false;
      });
    }, 15_000);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  /** One sampling pass over every (consumer group, topic) pair we consume. */
  async sample(): Promise<void> {
    const topics =
      this.config.get<Record<string, string>>('kafka.topics') ?? {};
    const groups =
      this.config.get<Record<string, string>>('kafka.groupIds') ?? {};

    const pairs: Array<[string, string | undefined]> = [
      [groups['critical'] ?? 'notification-critical-cg', topics['critical']],
      [groups['standard'] ?? 'notification-standard-cg', topics['events']],
    ];

    for (const [groupId, topic] of pairs) {
      if (!topic) continue;
      try {
        for (const { partition, lag } of await this.kafka.getConsumerLag(
          groupId,
          topic,
        )) {
          this.prometheus.kafkaConsumerLag.set(
            { topic, partition: String(partition), consumer_group: groupId },
            lag,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Lag sample failed for ${groupId}/${topic}: ${(err as Error).message}`,
        );
      }
    }
  }
}
