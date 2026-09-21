// src/notifications/engine/notification-engine.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { DeduplicationService } from './deduplication.service';
import { StateService } from '../state-machine/state.service';
import { RoutingEngineService } from '../routing/routing-engine.service';
import { TemplateEngineService } from '../../templates/engine/template-engine.service';
import { FrequencyCapService } from '../../compliance/frequency-cap/frequency-cap.service';
import { QuietHoursService } from '../../compliance/quiet-hours/quiet-hours.service';
import { DndClassifierService } from '../../compliance/dnd/dnd-classifier.service';
import { DeliveryService } from '../../delivery/delivery.service';
import { DispatchService } from '../../delivery/dispatch/dispatch.service';
import { NotificationStatus } from '../../shared/constants/notification-states';
import { type EventType } from '../../shared/constants/event-types';
import { type Channel } from '../../shared/constants/channels';
import { REDIS_KEYS } from '../../shared/constants/redis-keys';
import { type SupportedLocale } from '../../shared/utils/currency.util';
import { dedupSourceEntity } from '../../shared/utils/fingerprint.util';
import { getMarketProfile } from '../../shared/markets/market-profiles';
import { v4 as uuidv4 } from 'uuid';
import { IngestEventDto } from '../dto/ingest-event.dto';
import { Prisma } from '@prisma/client';
import { AbTestingService } from '../../templates/engine/ab-testing.service';
import { SendTimeOptimizationService } from './send-time-optimization.service';
import {
  DigestBucketService,
  DigestSource,
} from '../digest/digest-bucket.service';

interface EngineUser {
  id: string;
  name: string;
  phone: string;
  email: string;
  language: string;
  timezone: string;
  accountType: string;
  market: string;
  quietHoursEnd?: string;
}

/** What a channel fan-out needs to know about the originating event. */
interface DispatchContext {
  notificationId: string;
  eventType: string;
  eventId: string;
  priority: number;
  payload: Record<string, unknown>;
  correlationId: string;
  classification: 'TRANSACTIONAL' | 'PROMOTIONAL';
  regulatoryOverride: boolean;
}

/**
 * Event → notification pipeline (the "qualify" phase).
 *
 * dedup → user context → notification record → preference/cap/quiet-hours
 * routing → per-channel render → RabbitMQ publish.
 *
 * Delivery itself (DND check, provider call, retry) happens later in the
 * delivery workers, never in this call path.
 */
@Injectable()
export class NotificationEngineService {
  private readonly logger = new Logger(NotificationEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly prometheus: PrometheusService,
    private readonly deduplication: DeduplicationService,
    private readonly stateService: StateService,
    private readonly routingEngine: RoutingEngineService,
    private readonly templateEngine: TemplateEngineService,
    private readonly frequencyCap: FrequencyCapService,
    private readonly quietHours: QuietHoursService,
    private readonly dndClassifier: DndClassifierService,
    private readonly delivery: DeliveryService,
    private readonly dispatch: DispatchService,
    private readonly abTesting: AbTestingService,
    private readonly sendTimeOptimization: SendTimeOptimizationService,
    private readonly digestBuckets: DigestBucketService,
  ) {}

  /**
   * @param presetNotificationId id already handed to the API caller at ingestion
   *   time. Kafka delivers at-least-once, so the same message can arrive again;
   *   a matching id that has already progressed past CREATED is a no-op.
   */
  async process(
    dto: IngestEventDto,
    correlationId: string,
    presetNotificationId?: string,
  ): Promise<{ notificationId: string; channelsTargeted: string[] }> {
    const notificationId = presetNotificationId ?? uuidv4();

    // ── Step 1: Deduplication ─────────────────────────────────────
    // Scoped per user: a price alert for RELIANCE must reach every user
    // watching it, while 500 duplicates for the SAME user collapse to one.
    const sourceEntityId = dedupSourceEntity(
      dto.userId,
      dto.payload,
      dto.eventId,
    );

    const dupCheck = await this.deduplication.check(
      dto.idempotencyKey,
      dto.eventType,
      dto.userId,
      sourceEntityId,
    );

    // A duplicate pointing at OUR OWN id is just this message being redelivered.
    if (
      dupCheck.isDuplicate &&
      dupCheck.existingNotificationId !== notificationId
    ) {
      this.logger.debug(
        `Duplicate event ${dto.eventType} for user ${dto.userId} — reason: ${dupCheck.reason}`,
      );
      return {
        notificationId: dupCheck.existingNotificationId ?? notificationId,
        channelsTargeted: [],
      };
    }

    const existing = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { status: true },
    });

    if (
      existing &&
      (existing.status as NotificationStatus) !== NotificationStatus.CREATED
    ) {
      return { notificationId, channelsTargeted: [] }; // already processed
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
        market: true,
        quietHoursEnd: true,
      },
    });

    if (!user) {
      this.logger.error(`User ${dto.userId} not found — dropping event`);
      return { notificationId, channelsTargeted: [] };
    }

    // ── Step 3: Create notification record ────────────────────────

    const classification = this.dndClassifier.classify(
      dto.eventType as EventType,
    );

    if (!existing) {
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
          classification,
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
    }

    // ── Step 4: Route ─────────────────────────────────────────────

    const routingDecision = await this.routingEngine.route(
      dto.eventType as EventType,
      {
        userId: user.id,
        accountType: user.accountType,
        timezone: user.timezone,
      },
      dto.priority,
    );

    // Only dispatch to channels the event's template actually serves; the rest
    // are recorded as suppressed rather than sent to the DLQ.
    const unsupported = routingDecision.channels.filter(
      (c) => !this.templateEngine.supportsChannel(dto.eventType, c),
    );
    routingDecision.channels = routingDecision.channels.filter(
      (c) => !unsupported.includes(c),
    );
    routingDecision.suppressedChannels.push(
      ...unsupported.map((channel) => ({
        channel,
        reason: 'NO_TEMPLATE_FOR_CHANNEL',
      })),
    );

    const capped = routingDecision.suppressedChannels.some(
      (c) =>
        c.reason !== 'QUIET_HOURS' && c.reason !== 'NO_TEMPLATE_FOR_CHANNEL',
    );

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        regulatoryOverride: routingDecision.regulatoryOverride,
        frequencyCapChecked: true,
        frequencyCapResult: capped ? 'CAPPED' : 'WITHIN_LIMITS',
      },
    });

    await this.stateService.transition(
      notificationId,
      NotificationStatus.ENRICHED,
      'enrichment_worker',
      {
        resolvedChannels: routingDecision.channels,
        ...(routingDecision.policyBypasses && {
          policyBypasses: routingDecision.policyBypasses,
        }),
      },
    );

    // The user wants this category as a digest: hold it, deliver it later inside one.
    if (routingDecision.digest) {
      const source: DigestSource =
        routingDecision.digest.mode === 'HOURLY' ? 'hourly' : 'daily';
      const dueAt =
        source === 'hourly'
          ? DigestBucketService.nextHour()
          : this.quietHours.nextActiveWindowStart(
              user.timezone,
              user.quietHoursEnd,
            );

      await this.stateService.transition(
        notificationId,
        NotificationStatus.DIGEST_PENDING,
        'digest_aggregator',
        { source, dueAt: dueAt.toISOString() },
      );
      await this.digestBuckets.add(user.id, source, notificationId, dueAt);

      return { notificationId, channelsTargeted: [] };
    }

    // Handle quiet hours suppression — deliver when the window opens
    const deferredChannels = routingDecision.suppressedChannels
      .filter((c) => c.reason === 'QUIET_HOURS')
      .map((c) => c.channel)
      .filter((c) => this.templateEngine.supportsChannel(dto.eventType, c));

    if (routingDecision.quietHoursDelay && deferredChannels.length > 0) {
      const deliverAt = new Date(routingDecision.quietHoursDelay.deliverAt);

      await this.stateService.transition(
        notificationId,
        NotificationStatus.QUIET,
        'quiet_hours_service',
        { deliverAt: deliverAt.toISOString() },
      );

      await this.quietHours.queue(dto.userId, notificationId, deliverAt);
      await this.scheduleRelease(
        notificationId,
        deferredChannels,
        deliverAt,
        'quiet',
        dto.userId,
      );

      return { notificationId, channelsTargeted: [] };
    }

    // Handle full suppression
    if (routingDecision.channels.length === 0) {
      await this.stateService.transition(
        notificationId,
        NotificationStatus.CAPPED,
        'routing_engine',
        { suppressedChannels: routingDecision.suppressedChannels },
      );

      // Suppressed by a frequency cap (not merely "no template"): remember it, so
      // that if 3 or more pile up they go out as one digest (spec Appendix B).
      const capReasons = routingDecision.suppressedChannels.filter(
        (c) => c.reason !== 'NO_TEMPLATE_FOR_CHANNEL',
      );
      if (capReasons.length > 0) {
        await this.digestBuckets.add(
          user.id,
          'capped',
          notificationId,
          this.quietHours.nextActiveWindowStart(
            user.timezone,
            user.quietHoursEnd,
          ),
        );
      }
      return { notificationId, channelsTargeted: [] };
    }

    // ── Send-Time Optimization (STO) Interceptor ──────────────────

    const stoDecision = await this.sendTimeOptimization.decide(
      user.id,
      dto.eventType as EventType,
      dto.priority,
      user.timezone,
    );

    if (stoDecision.optimize && stoDecision.delayMs) {
      const releaseAt = new Date(Date.now() + stoDecision.delayMs);

      await this.stateService.transition(
        notificationId,
        NotificationStatus.ROUTED,
        'send-time-optimizer',
        {
          channels: routingDecision.channels,
          deferredUntil: releaseAt.toISOString(),
          reason: stoDecision.reason,
        },
      );
      await this.scheduleRelease(
        notificationId,
        routingDecision.channels,
        releaseAt,
        'sto',
        dto.userId,
      );

      this.logger.log(
        `Notification ${notificationId} delayed ${Math.round(stoDecision.delayMs / 60000)}min for send-time optimization`,
      );

      return { notificationId, channelsTargeted: routingDecision.channels };
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

    await this.fanOut(
      {
        notificationId,
        eventType: dto.eventType,
        eventId: dto.eventId,
        priority: dto.priority,
        payload: dto.payload,
        correlationId,
        classification,
        regulatoryOverride: routingDecision.regulatoryOverride,
      },
      user,
      routingDecision.channels,
    );

    return { notificationId, channelsTargeted: routingDecision.channels };
  }

  /**
   * Releases a deferred notification (quiet hours / send-time optimisation)
   * once its window has opened. Safe to call twice: only a QUIET or ROUTED
   * notification is dispatched.
   */
  async resume(notificationId: string, channels: Channel[]): Promise<void> {
    const n = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            language: true,
            timezone: true,
            accountType: true,
            market: true,
          },
        },
      },
    });

    if (!n) return;

    this.logger.log(
      `Releasing ${notificationId} (${n.status}) to [${channels.join(', ')}]`,
    );

    if ((n.status as NotificationStatus) === NotificationStatus.QUIET) {
      await this.quietHours.removeFromQueue(n.userId, n.id);
      await this.stateService.transition(
        n.id,
        NotificationStatus.ROUTED,
        'scheduled_release',
        { channels },
      );
    } else if ((n.status as NotificationStatus) !== NotificationStatus.ROUTED) {
      return; // already dispatched by an earlier release
    }

    await this.fanOut(
      {
        notificationId: n.id,
        eventType: n.eventType,
        eventId: n.eventId,
        priority: n.priority,
        payload: n.personalisationData as Record<string, unknown>,
        correlationId: n.correlationId,
        classification: n.classification,
        regulatoryOverride: n.regulatoryOverride,
      },
      n.user,
      channels,
    );
  }

  // ── Fan-out ──────────────────────────────────────────────────────

  /**
   * One notification row per channel: the original row carries the first
   * channel, each further channel gets a sibling row so every channel has its
   * own state history, provider id, cost and DLR.
   */
  private async fanOut(
    ctx: DispatchContext,
    user: EngineUser,
    channels: Channel[],
  ): Promise<void> {
    const locale = user.language.toLowerCase() as SupportedLocale;

    for (const [index, channel] of channels.entries()) {
      const id =
        index === 0
          ? ctx.notificationId
          : await this.createSibling(ctx, user.id, channel);

      await this.renderAndQueue(id, ctx, user, channel, locale, index === 0);
    }
  }

  private async createSibling(
    ctx: DispatchContext,
    userId: string,
    channel: Channel,
  ): Promise<string> {
    const id = uuidv4();

    await this.prisma.notification.create({
      data: {
        id,
        eventType: ctx.eventType,
        eventId: ctx.eventId,
        userId,
        channel,
        priority: ctx.priority,
        status: NotificationStatus.ROUTED,
        templateId: `${ctx.eventType}-v1`,
        templateVersion: 1,
        personalisationData: ctx.payload as Prisma.InputJsonValue,
        correlationId: ctx.correlationId,
        classification: ctx.classification,
        regulatoryOverride: ctx.regulatoryOverride,
        frequencyCapChecked: true,
        frequencyCapResult: 'WITHIN_LIMITS',
        metadata: { parentNotificationId: ctx.notificationId },
      },
    });

    await this.prisma.notificationStateLog.create({
      data: {
        notificationId: id,
        fromStatus: null,
        toStatus: NotificationStatus.ROUTED,
        actor: 'routing_engine',
        metadata: { parentNotificationId: ctx.notificationId, channel },
      },
    });

    return id;
  }

  private async renderAndQueue(
    notificationId: string,
    ctx: DispatchContext,
    user: EngineUser,
    channel: Channel,
    locale: SupportedLocale,
    countEvent: boolean,
  ): Promise<void> {
    // A digest is a system notification, not a business event: it has no row in
    // the templates table, so there is nothing to A/B test.
    const isDigest = ctx.eventType === 'DIGEST';
    const templateId = isDigest
      ? 'DIGEST-v1'
      : (await this.abTesting.resolveVariant(user.id, ctx.eventType))
          .templateId;

    try {
      const rendered = await this.templateEngine.render(templateId, channel, {
        userId: user.id,
        userName: user.name,
        language: locale,
        timezone: user.timezone,
        currency: getMarketProfile(user.market).currency,
        payload: ctx.payload,
        appName: this.config.get<string>('app.name') ?? 'WealthBridge',
      });

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          channel,
          templateId,
          renderedContent: rendered as unknown as Prisma.InputJsonValue,
        },
      });

      // ROUTED → QUEUED (the state machine records the transition itself)
      await this.stateService.transition(
        notificationId,
        NotificationStatus.QUEUED,
        'rabbitmq_publisher',
        { channel, templateId },
      );

      await this.frequencyCap.record(
        user.id,
        ctx.eventType as EventType,
        channel,
        countEvent,
      );

      await this.dispatch.publish({
        notificationId,
        userId: user.id,
        channel,
        recipient: `user:${user.id}`, // address resolved by the worker at send time
        subject: rendered.subject,
        title: rendered.title,
        body: rendered.body,
        data: rendered.data,
        priority: ctx.priority,
        correlationId: ctx.correlationId,
      });
    } catch (err) {
      // Never swallow: a notification that cannot be rendered or queued goes
      // to the DLQ where operators can see and act on it.
      const message = (err as Error).message;
      this.logger.error(
        `Failed to render/queue ${notificationId} for ${channel}: ${message}`,
      );
      await this.delivery.deadLetter(
        notificationId,
        { eventType: ctx.eventType, channel, payload: ctx.payload },
        { message, code: 'RENDER_OR_QUEUE_FAILED' },
      );
    }

    if (!isDigest) {
      await this.abTesting.recordExposure(
        user.id,
        ctx.eventType,
        templateId,
        notificationId,
      );
    }
  }

  // ── Deferred release scheduling ──────────────────────────────────

  private async scheduleRelease(
    notificationId: string,
    channels: Channel[],
    releaseAt: Date,
    kind: 'quiet' | 'sto',
    userId: string,
  ): Promise<void> {
    await this.redis.zadd(
      REDIS_KEYS.scheduledRelease,
      releaseAt.getTime(),
      JSON.stringify({ id: notificationId, channels, kind, userId }),
    );
  }

  /**
   * A QUIET notification whose window has opened, but which belongs to a pile of
   * more than 5 that built up overnight: hold it for the morning digest instead
   * of releasing it on its own (spec A6.3).
   */
  async deferToDigest(notificationId: string): Promise<void> {
    const n = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { status: true, userId: true },
    });
    if (!n || (n.status as NotificationStatus) !== NotificationStatus.QUIET) {
      return; // already released or handled elsewhere
    }

    await this.quietHours.removeFromQueue(n.userId, notificationId);
    await this.stateService.transition(
      notificationId,
      NotificationStatus.DIGEST_PENDING,
      'digest_aggregator',
      { source: 'quiet' },
    );
    await this.digestBuckets.add(n.userId, 'quiet', notificationId, new Date());
  }
}
