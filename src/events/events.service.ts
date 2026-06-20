// src/events/events.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { NotificationEngineService } from '../notifications/engine/notification-engine.service';
import { IngestEventDto } from '../notifications/dto/ingest-event.dto';
import { v4 as uuidv4 } from 'uuid';

/**
 * Events service — thin facade over the notification engine.
 * Responsible for:
 * - Validating the incoming event structure
 * - Assigning a correlation ID
 * - Routing to the correct Kafka topic based on priority
 * - Returning the acceptance response
 *
 * Separation from NotificationsModule keeps event ingestion
 * concerns distinct from notification lifecycle management.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly engine: NotificationEngineService) {}

  async ingest(
    dto: IngestEventDto,
    correlationId?: string,
  ): Promise<{
    notification_id: string;
    event_id: string;
    status: string;
    channels_targeted: string[];
    estimated_delivery_ms: number;
    created_at: string;
  }> {
    const cid = correlationId ?? uuidv4();

    this.logger.log(
      `Ingesting event ${dto.eventType} for user ${dto.userId} correlationId=${cid}`,
    );

    const result = await this.engine.process(dto, cid);

    return {
      notification_id: result.notificationId,
      event_id: dto.eventId,
      status: 'CREATED',
      channels_targeted: result.channelsTargeted,
      estimated_delivery_ms: this.estimateDeliveryMs(dto.priority),
      created_at: new Date().toISOString(),
    };
  }

  private estimateDeliveryMs(priority: number): number {
    const estimates: Record<number, number> = {
      1: 3_000,
      2: 10_000,
      3: 60_000,
      5: 300_000,
    };
    return estimates[priority] ?? 30_000;
  }
}
