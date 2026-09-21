// src/delivery/workers/delivery-worker.service.ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMQService } from '../../infrastructure/rabbitmq/rabbitmq.service';
import { DeliveryService } from '../delivery.service';
import { PreparedNotification } from '../providers/delivery-provider.interface';

interface QueueConfig {
  name: string;
  prefetch: number;
}

/**
 * Consumes the per-channel RabbitMQ queues and hands each message to
 * DeliveryService.process().
 *
 * Delivery is decoupled from event processing (no synchronous provider calls
 * in the ingestion path) so a slow provider can only back up its own channel
 * queue. Priority is honoured by the queues' x-max-priority.
 *
 * Ack semantics:
 *  - process() resolved  → ack (delivered, retried later, blocked or dead-lettered
 *    — every outcome is persisted by DeliveryService).
 *  - process() threw     → nack without requeue → the queue's dead-letter exchange,
 *    so a poison message can never spin in a redelivery loop.
 *
 * Disable with DELIVERY_WORKERS_ENABLED=false (e.g. to run an API-only replica).
 */
@Injectable()
export class DeliveryWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeliveryWorkerService.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly delivery: DeliveryService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('DELIVERY_WORKERS_ENABLED') === 'false') {
      this.logger.warn(
        'Delivery workers disabled (DELIVERY_WORKERS_ENABLED=false)',
      );
      return;
    }

    const queues =
      this.config.get<Record<string, QueueConfig>>('rabbitmq.queues') ?? {};

    for (const [key, queue] of Object.entries(queues)) {
      // The retry queue is republished into the channel queues, not consumed here.
      if (key === 'retry') continue;

      await this.rabbitmq.consume(
        queue.name,
        queue.prefetch,
        (msg, ack, nack) => this.handle(queue.name, msg, ack, nack),
      );
    }
  }

  private async handle(
    queueName: string,
    message: Record<string, unknown>,
    ack: () => void,
    nack: (requeue?: boolean) => void,
  ): Promise<void> {
    try {
      await this.delivery.process(message as unknown as PreparedNotification);
      ack();
    } catch (err) {
      this.logger.error(
        `Delivery failed on ${queueName} for ${String(message['notificationId'])}: ` +
          `${(err as Error).message}`,
      );
      nack(false);
    }
  }
}
