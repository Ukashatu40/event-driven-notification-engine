// src/events/ingestion-consumer.service.ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaService } from '../infrastructure/kafka/kafka.service';
import { NotificationEngineService } from '../notifications/engine/notification-engine.service';
import type { IngestEnvelope } from './events.service';

/**
 * Kafka → engine bridge.
 *
 * Two independent consumer groups, so CRITICAL traffic has its own consumers
 * and can never be starved by the standard backlog (Case Study C4):
 *   notification-critical-cg  ← notification-critical
 *   notification-standard-cg  ← notification-events
 *
 * Offsets are committed manually after the handler returns (at-least-once).
 * If the engine throws, the envelope is parked on `notification-dlq` and the
 * offset is then committed — a poison message is recorded, never silently
 * skipped and never blocking the partition.
 *
 * Disable with KAFKA_CONSUMERS_ENABLED=false (API-only replica).
 */
@Injectable()
export class IngestionConsumerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestionConsumerService.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly engine: NotificationEngineService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('KAFKA_CONSUMERS_ENABLED') === 'false') {
      this.logger.warn(
        'Ingestion consumers disabled (KAFKA_CONSUMERS_ENABLED=false)',
      );
      return;
    }

    const topics =
      this.config.get<Record<string, string>>('kafka.topics') ?? {};
    const groups =
      this.config.get<Record<string, string>>('kafka.groupIds') ?? {};

    const handler = this.handle.bind(this);

    await this.kafka.subscribe(
      groups['critical'] ?? 'notification-critical-cg',
      [topics['critical']],
      handler,
    );
    await this.kafka.subscribe(
      groups['standard'] ?? 'notification-standard-cg',
      [topics['events']],
      handler,
    );
  }

  private async handle(
    topic: string,
    _partition: number,
    message: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<void> {
    const envelope = message as unknown as IngestEnvelope;

    try {
      await this.engine.process(
        envelope.event,
        envelope.correlationId ?? headers['correlation-id'],
        envelope.notificationId,
      );
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(
        `Engine failed for ${envelope?.event?.eventId} on ${topic}: ${reason} — parking on DLQ topic`,
      );

      const dlqTopic =
        this.config.get<Record<string, string>>('kafka.topics')?.['dlq'] ??
        'notification-dlq';

      // If even the DLQ publish fails, rethrow: the offset stays uncommitted
      // is NOT guaranteed by KafkaService, so surface it loudly.
      await this.kafka.publish(
        dlqTopic,
        {
          key: envelope?.event?.userId,
          value: { ...message, failedTopic: topic, error: reason },
        },
        envelope?.correlationId,
      );
    }
  }
}
