// src/events/events.service.ts
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { KafkaService } from '../infrastructure/kafka/kafka.service';
import { PreferenceResolverService } from '../preferences/preference-resolver.service';
import { DeduplicationService } from '../notifications/engine/deduplication.service';
import { IngestEventDto } from '../notifications/dto/ingest-event.dto';
import { type EventType } from '../shared/constants/event-types';
import { dedupSourceEntity } from '../shared/utils/fingerprint.util';
import { v4 as uuidv4 } from 'uuid';
import { validateEvent } from './validators/event-payload.validator';
import { ValidationFailedException } from '../shared/pipes/validation.pipe';

/** Envelope published to Kafka; the ingestion consumer unwraps it. */
export interface IngestEnvelope {
  notificationId: string;
  correlationId: string;
  event: IngestEventDto;
}

/**
 * Event ingestion facade — the API side of the pipeline.
 *
 * Validates the caller's event, rejects unknown users, short-circuits
 * duplicates, and publishes to Kafka: CRITICAL (priority 1) events go to the
 * dedicated `notification-critical` topic so they can never queue behind
 * market chatter; everything else goes to `notification-events`. The record is
 * keyed by userId so all of a user's events land on one partition, in order.
 *
 * Processing is asynchronous — the 202 is returned as soon as Kafka has
 * durably accepted the event (acks=all, idempotent producer).
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly config: ConfigService,
    private readonly preferenceResolver: PreferenceResolverService,
    private readonly deduplication: DeduplicationService,
  ) {}

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
    // Reject malformed events before anything is claimed, queued or stored.
    const problems = validateEvent(dto);
    if (problems.length > 0) {
      throw new ValidationFailedException(
        problems,
        'Event payload validation failed',
      );
    }

    const cid = correlationId ?? uuidv4();

    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true, accountType: true },
    });
    if (!user) {
      throw new NotFoundException(`User ${dto.userId} not found`);
    }

    // Dedup at the door, atomically: claim the idempotency key + fingerprint for
    // the id we are about to hand out. A repeat gets the ORIGINAL id back and
    // never reaches Kafka (challenge B2.4: dedupe within the ingestion layer).
    const notificationId = uuidv4();
    const sourceEntityId = dedupSourceEntity(
      dto.userId,
      dto.payload,
      dto.eventId,
    );

    const claim = await this.deduplication.claim(
      notificationId,
      dto.idempotencyKey,
      dto.eventType,
      sourceEntityId,
    );
    if (claim.isDuplicate && claim.existingNotificationId) {
      return this.accepted(claim.existingNotificationId, dto, []);
    }

    this.logger.log(
      `Ingesting event ${dto.eventType} for user ${dto.userId} correlationId=${cid}`,
    );

    // Channels the user is expected to receive on (preference + regulatory
    // layers). Compliance filtering happens later, so this is the *target*.
    const resolved = await this.preferenceResolver.resolve(
      user.id,
      dto.eventType as EventType,
      user.accountType,
    );

    const topics =
      this.config.get<Record<string, string>>('kafka.topics') ?? {};
    const topic = dto.priority === 1 ? topics['critical'] : topics['events'];
    if (!topic) {
      await this.release(notificationId, dto, sourceEntityId);
      throw new ServiceUnavailableException('Kafka topics are not configured');
    }

    const envelope: IngestEnvelope = {
      notificationId,
      correlationId: cid,
      event: dto,
    };

    try {
      await this.kafka.publish(
        topic,
        {
          key: dto.userId,
          value: envelope as unknown as Record<string, unknown>,
        },
        cid,
      );
    } catch (err) {
      this.logger.error(
        `Kafka publish failed for ${dto.eventId}: ${(err as Error).message}`,
      );
      // Un-claim, otherwise the caller's retry would be answered as a
      // "duplicate" of an event that never made it onto the bus.
      await this.release(notificationId, dto, sourceEntityId);
      throw new ServiceUnavailableException(
        'Event bus unavailable — event was not accepted, please retry',
      );
    }

    return this.accepted(notificationId, dto, resolved.channels);
  }

  private release(
    notificationId: string,
    dto: IngestEventDto,
    sourceEntityId: string,
  ): Promise<void> {
    return this.deduplication.release(
      notificationId,
      dto.idempotencyKey,
      dto.eventType,
      sourceEntityId,
    );
  }

  private accepted(
    notificationId: string,
    dto: IngestEventDto,
    channels: string[],
  ) {
    return {
      notification_id: notificationId,
      event_id: dto.eventId,
      status: 'CREATED',
      channels_targeted: channels,
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
