// src/notifications/digest/digest-flush.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { QuietHoursService } from '../../compliance/quiet-hours/quiet-hours.service';
import { TemplateEngineService } from '../../templates/engine/template-engine.service';
import { NotificationStatus } from '../../shared/constants/notification-states';
import { type Channel } from '../../shared/constants/channels';
import { type SupportedLocale } from '../../shared/utils/currency.util';
import { getMarketProfile } from '../../shared/markets/market-profiles';
import { NotificationEngineService } from '../engine/notification-engine.service';
import {
  DIGEST_MIN_ITEMS,
  DigestBucketService,
  DigestSource,
} from './digest-bucket.service';

/** Digests go out on free, consent-free, DND-free channels only. */
const DIGEST_CHANNELS: Channel[] = ['push', 'in_app'];
const MAX_LINES = 5;
const MAX_LINE_LENGTH = 100;
const RETRY_DELAY_MS = 5 * 60_000;

export type FlushOutcome =
  | 'sent'
  | 'empty'
  | 'below-threshold'
  | 'deferred'
  | 'failed'
  | 'no-user';

/**
 * Builds and sends digests (spec Day 5, A6.3, Appendix B).
 *
 * A digest is ONE new notification (`eventType: DIGEST`) that summarises many
 * held ones. It goes through the normal pipeline (state machine, RabbitMQ,
 * delivery worker), so it is tracked, retried and dead-lettered like any other;
 * the notifications it absorbs end in DIGESTED, each pointing at the digest.
 *
 * Nothing is ever dropped silently: if a flush cannot complete, its items go
 * back into their bucket and are retried in 5 minutes.
 */
@Injectable()
export class DigestFlushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DigestFlushService.name);
  private handle: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly buckets: DigestBucketService,
    private readonly engine: NotificationEngineService,
    private readonly templates: TemplateEngineService,
    private readonly quietHours: QuietHoursService,
    private readonly prometheus: PrometheusService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('DIGEST_ENABLED') === 'false') return;
    this.handle = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void this.flushDue().finally(() => {
        this.polling = false;
      });
    }, 30_000);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  /** Flushes every bucket due at `asOf`. Returns how many digests were sent. */
  async flushDue(asOf = Date.now()): Promise<number> {
    let sent = 0;
    for (const { userId, source } of await this.buckets.claimDue(asOf)) {
      try {
        if ((await this.flush(userId, source)) === 'sent') sent++;
      } catch (err) {
        this.logger.error(
          `Digest flush failed for ${userId}/${source}: ${(err as Error).message}`,
        );
      }
    }
    return sent;
  }

  async flush(userId: string, source: DigestSource): Promise<FlushOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        language: true,
        timezone: true,
        market: true,
      },
    });
    if (!user) {
      await this.buckets.take(userId, source);
      return 'no-user';
    }

    const ids = await this.buckets.take(userId, source);
    if (ids.length === 0) return 'empty';

    // A user-chosen hourly/daily digest must still respect quiet hours.
    if (source === 'hourly' || source === 'daily') {
      const quiet = await this.quietHours.checkWindow(userId);
      if (quiet.suppressed) {
        await this.buckets.restore(
          userId,
          source,
          ids,
          new Date(quiet.deliverAt),
        );
        return 'deferred';
      }
    }

    const items = await this.prisma.notification.findMany({
      where: {
        id: { in: ids },
        status: {
          in: [NotificationStatus.DIGEST_PENDING, NotificationStatus.CAPPED],
        },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        eventType: true,
        templateId: true,
        personalisationData: true,
        classification: true,
        status: true,
      },
    });
    if (items.length === 0) return 'empty';

    if (items.length < DIGEST_MIN_ITEMS[source]) {
      // e.g. 2 capped notifications: not worth a digest; they stay CAPPED.
      return 'below-threshold';
    }

    try {
      return await this.send(user, source, items);
    } catch (err) {
      // Put everything back and retry later — never lose held notifications.
      await this.buckets.restore(
        userId,
        source,
        ids,
        new Date(Date.now() + RETRY_DELAY_MS),
      );
      throw err;
    }
  }

  private async send(
    user: {
      id: string;
      name: string;
      language: string;
      timezone: string;
      market: string;
    },
    source: DigestSource,
    items: Array<{
      id: string;
      eventType: string;
      templateId: string;
      personalisationData: Prisma.JsonValue;
      classification: 'TRANSACTIONAL' | 'PROMOTIONAL';
      status: string;
    }>,
  ): Promise<FlushOutcome> {
    const locale = user.language.toLowerCase() as SupportedLocale;
    const currency = getMarketProfile(user.market).currency;

    // CAPPED → DIGEST_PENDING, so every folded notification follows the same path.
    for (const item of items.filter(
      (i) => (i.status as NotificationStatus) === NotificationStatus.CAPPED,
    )) {
      await this.prisma.notification.update({
        where: { id: item.id },
        data: {
          status: NotificationStatus.DIGEST_PENDING,
          updatedAt: new Date(),
        },
      });
      await this.prisma.notificationStateLog.create({
        data: {
          notificationId: item.id,
          fromStatus: NotificationStatus.CAPPED,
          toStatus: NotificationStatus.DIGEST_PENDING,
          actor: 'digest_aggregator',
          metadata: { source },
        },
      });
    }

    // One line per folded notification, in the user's language.
    const shown = items.slice(0, MAX_LINES);
    const lines = await Promise.all(
      shown.map((item) => this.lineFor(item, user, locale, currency)),
    );

    const digestId = uuidv4();
    await this.prisma.notification.create({
      data: {
        id: digestId,
        eventType: 'DIGEST',
        eventId: `DIGEST-${digestId}`,
        userId: user.id,
        channel: 'pending',
        priority: 5,
        status: NotificationStatus.ROUTED,
        templateId: 'DIGEST-v1',
        templateVersion: 1,
        personalisationData: {
          count: items.length,
          items: lines.map((text) => ({ text })),
          more: Math.max(0, items.length - MAX_LINES),
          source,
        },
        correlationId: uuidv4(),
        // Promotional if ANY folded item was — the stricter rules then apply.
        classification: items.some((i) => i.classification === 'PROMOTIONAL')
          ? 'PROMOTIONAL'
          : 'TRANSACTIONAL',
        metadata: { digestOf: items.map((i) => i.id), source },
      },
    });
    await this.prisma.notificationStateLog.create({
      data: {
        notificationId: digestId,
        fromStatus: null,
        toStatus: NotificationStatus.ROUTED,
        actor: 'digest_aggregator',
        metadata: { source, count: items.length },
      },
    });

    await this.engine.resume(digestId, DIGEST_CHANNELS);

    const digest = await this.prisma.notification.findUnique({
      where: { id: digestId },
      select: { status: true },
    });
    if (
      (digest?.status as NotificationStatus | undefined) ===
      NotificationStatus.DLQ
    ) {
      // Rendering/queueing the digest itself failed (it is in the DLQ for an
      // operator). The held notifications are untouched, so they go back.
      throw new Error(`Digest ${digestId} could not be queued`);
    }

    for (const item of items) {
      await this.prisma.notification.update({
        where: { id: item.id },
        data: { status: NotificationStatus.DIGESTED, updatedAt: new Date() },
      });
      await this.prisma.notificationStateLog.create({
        data: {
          notificationId: item.id,
          fromStatus: NotificationStatus.DIGEST_PENDING,
          toStatus: NotificationStatus.DIGESTED,
          actor: 'digest_aggregator',
          metadata: { digestNotificationId: digestId, source },
        },
      });
    }

    this.prometheus.digestsSentTotal.inc({ source });
    this.prometheus.digestItemsTotal.inc({ source }, items.length);
    this.logger.log(
      `Digest ${digestId} (${source}) sent to ${user.id}: ${items.length} notification(s)`,
    );
    return 'sent';
  }

  /** The item's own push/in-app text, rendered in the user's language. */
  private async lineFor(
    item: {
      eventType: string;
      templateId: string;
      personalisationData: Prisma.JsonValue;
    },
    user: { id: string; name: string; timezone: string },
    locale: SupportedLocale,
    currency: 'INR' | 'NGN',
  ): Promise<string> {
    for (const channel of ['push', 'in_app'] as const) {
      if (!this.templates.supportsChannel(item.eventType, channel)) continue;
      try {
        const r = await this.templates.render(item.templateId, channel, {
          userId: user.id,
          userName: user.name,
          language: locale,
          timezone: user.timezone,
          currency,
          payload: (item.personalisationData ?? {}) as Record<string, unknown>,
        });
        const text = [r.title, r.body].filter(Boolean).join(': ');
        if (text) return this.clip(text);
      } catch {
        // fall through to the next channel / the fallback below
      }
    }
    return item.eventType;
  }

  private clip(text: string): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > MAX_LINE_LENGTH
      ? `${one.slice(0, MAX_LINE_LENGTH - 1)}…`
      : one;
  }
}
