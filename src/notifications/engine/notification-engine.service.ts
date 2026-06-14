// src/notifications/engine/notification-engine.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RabbitMQService } from '../../infrastructure/rabbitmq/rabbitmq.service';
import { ConfigService } from '@nestjs/config';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { DeduplicationService } from './deduplication.service';
import { StateService } from '../state-machine/state.service';
import { RoutingEngineService } from '../routing/routing-engine.service';
import { TemplateEngineService } from '../../templates/engine/template-engine.service';
import { FrequencyCapService } from '../../compliance/frequency-cap/frequency-cap.service';
import { QuietHoursService } from '../../compliance/quiet-hours/quiet-hours.service';
import { NotificationStatus } from '../../shared/constants/notification-states';
import { type EventType } from '../../shared/constants/event-types';
import { type Channel } from '../../shared/constants/channels';
import { type SupportedLocale } from '../../shared/utils/currency.util';
import { v4 as uuidv4 } from 'uuid';
import { IngestEventDto } from '../dto/ingest-event.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class NotificationEngineService {
  private readonly logger = new Logger(NotificationEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbitmq: RabbitMQService,
    private readonly config: ConfigService,
    private readonly prometheus: PrometheusService,
    private readonly deduplication: DeduplicationService,
    private readonly stateService: StateService,
    private readonly routingEngine: RoutingEngineService,
    private readonly templateEngine: TemplateEngineService,
    private readonly frequencyCap: FrequencyCapService,
    private readonly quietHours: QuietHoursService,
  ) {}

  async process(dto: IngestEventDto, correlationId: string): Promise<string> {
    const notificationId = uuidv4();

    // ── Step 1: Deduplication ─────────────────────────────────────

    const sourceEntityId = String(
      dto.payload['symbol'] ?? dto.payload['order_id'] ?? dto.userId,
    );

    const dupCheck = await this.deduplication.check(
      dto.idempotencyKey,
      dto.eventType,
      dto.userId,
      sourceEntityId,
    );

    if (dupCheck.isDuplicate) {
      this.logger.debug(
        `Duplicate event ${dto.eventType} for user ${dto.userId} — reason: ${dupCheck.reason}`,
      );
      return dupCheck.existingNotificationId ?? notificationId;
    }

    // ── Step 2: Fetch user context ────────────────────────────────

    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        language: true,
        timezone: true,
        accountType: true,
      },
    });

    if (!user) {
      this.logger.error(`User ${dto.userId} not found — dropping event`);
      return notificationId;
    }

    // ── Step 3: Create notification record ────────────────────────

    await this.prisma.notification.create({
      data: {
        id: notificationId,
        eventType: dto.eventType,
        eventId: dto.eventId,
        userId: dto.userId,
        channel: 'pending',
        priority: dto.priority,
        status: NotificationStatus.CREATED,
        templateId: `${dto.eventType}-v1`,
        templateVersion: 1,
        personalisationData: dto.payload as Prisma.InputJsonValue,
        correlationId,
        idempotencyKey: dto.idempotencyKey,
        classification: this.classifyEvent(dto.eventType as EventType),
      },
    });

    await this.deduplication.register(
      notificationId,
      dto.idempotencyKey,
      dto.eventType,
      dto.userId,
      sourceEntityId,
    );

    this.prometheus.notificationEventsReceived.inc({
      event_type: dto.eventType,
      priority: String(dto.priority),
    });

    // ── Step 4: Route ─────────────────────────────────────────────

    const routingDecision = await this.routingEngine.route(
      dto.eventType as EventType,
      {
        userId: user.id,
        phone: user.phone,
        accountType: user.accountType,
        timezone: user.timezone,
      },
      dto.priority,
    );

    await this.stateService.transition(
      notificationId,
      NotificationStatus.ENRICHED,
      'enrichment_worker',
      { resolvedChannels: routingDecision.channels },
    );

    // Handle quiet hours suppression
    if (routingDecision.quietHoursDelay) {
      await this.stateService.transition(
        notificationId,
        NotificationStatus.QUIET,
        'quiet_hours_service',
        { deliverAt: routingDecision.quietHoursDelay.deliverAt },
      );

      await this.quietHours.queue(
        dto.userId,
        notificationId,
        new Date(routingDecision.quietHoursDelay.deliverAt),
      );

      return notificationId;
    }

    // Handle full suppression
    if (routingDecision.channels.length === 0) {
      await this.stateService.transition(
        notificationId,
        NotificationStatus.CAPPED,
        'routing_engine',
        { suppressedChannels: routingDecision.suppressedChannels },
      );
      return notificationId;
    }

    await this.stateService.transition(
      notificationId,
      NotificationStatus.ROUTED,
      'routing_engine',
      {
        channels: routingDecision.channels,
        suppressedChannels: routingDecision.suppressedChannels,
      },
    );

    // ── Step 5: Render and queue per channel ──────────────────────

    const locale = user.language.toLowerCase() as SupportedLocale;

    for (const channel of routingDecision.channels) {
      await this.renderAndQueue(
        notificationId,
        dto,
        user,
        channel,
        locale,
        correlationId,
      );
    }

    return notificationId;
  }

  private async renderAndQueue(
    notificationId: string,
    dto: IngestEventDto,
    user: {
      id: string;
      name: string;
      phone: string;
      email: string;
      language: string;
      timezone: string;
      accountType: string;
    },
    channel: Channel,
    locale: SupportedLocale,
    correlationId: string,
  ): Promise<void> {
    const templateId = `${dto.eventType}-v1`;

    try {
      const rendered = await this.templateEngine.render(templateId, channel, {
        userId: user.id,
        userName: user.name,
        language: locale,
        timezone: user.timezone,
        payload: dto.payload,
        appName: this.config.get<string>('app.name') ?? 'WealthBridge',
      });

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          channel,
          renderedContent: rendered,
          status: NotificationStatus.QUEUED,
        },
      });

      await this.stateService.transition(
        notificationId,
        NotificationStatus.QUEUED,
        'rabbitmq_publisher',
        { channel, templateId },
      );

      await this.frequencyCap.record(
        user.id,
        dto.eventType as EventType,
        channel,
      );

      const recipient = this.resolveRecipient(user, channel);

      await this.rabbitmq.publish(
        `notifications.${channel}`,
        {
          notificationId,
          userId: user.id,
          channel,
          recipient,
          subject: rendered.subject,
          title: rendered.title,
          body: rendered.body,
          data: rendered.data,
          priority: dto.priority,
          correlationId,
        },
        {
          priority: this.mapPriorityToRabbitMQ(dto.priority),
          correlationId,
          persistent: true,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to render/queue ${notificationId} for ${channel}: ${(err as Error).message}`,
      );
    }
  }

  private resolveRecipient(
    user: { phone: string; email: string; id: string },
    channel: Channel,
  ): string {
    const map: Record<Channel, string> = {
      sms: user.phone,
      email: user.email,
      push: user.id,
      whatsapp: user.phone,
      in_app: user.id,
    };
    return map[channel] ?? user.id;
  }

  private mapPriorityToRabbitMQ(priority: number): number {
    const map: Record<number, number> = { 1: 10, 2: 7, 3: 5, 5: 2 };
    return map[priority] ?? 5;
  }

  private classifyEvent(eventType: EventType): 'TRANSACTIONAL' | 'PROMOTIONAL' {
    const TRANSACTIONAL_PREFIXES = ['RISK', 'TXNX'];
    const category = eventType.split('-')[0] ?? '';
    return TRANSACTIONAL_PREFIXES.includes(category)
      ? 'TRANSACTIONAL'
      : 'PROMOTIONAL';
  }
}
