// src/notifications/preview/notification-preview.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { TemplateEngineService } from '../../templates/engine/template-engine.service';
import { AbTestingService } from '../../templates/engine/ab-testing.service';
import { SendTimeOptimizationService } from '../engine/send-time-optimization.service';
import { DndClassifierService } from '../../compliance/dnd/dnd-classifier.service';
import { FrequencyCapService } from '../../compliance/frequency-cap/frequency-cap.service';
import { PreferenceResolverService } from '../../preferences/preference-resolver.service';
import { EventType } from '../../shared/constants/event-types';
import { Channel, ALL_CHANNELS } from '../../shared/constants/channels';
import { Priority } from '../../shared/constants/priorities';
import { type SupportedLocale } from '../../shared/utils/currency.util';
import { getMarketProfile } from '../../shared/markets/market-profiles';

export interface ChannelPreview {
  channel: Channel;
  enabled: boolean;
  subject?: string;
  title?: string;
  body: string | null;
  renderError: string | null;
}

export interface NotificationPreview {
  userId: string;
  eventType: string;
  classification: string;
  templateId: string;
  templateVersion: number;
  isAbVariant: boolean;
  channels: ChannelPreview[];
  compliance: {
    wouldBeDndChecked: boolean;
    capUsage: {
      globalDaily: { used: number; cap: number };
      channelDaily: { used: number; cap: number };
      categoryHourly: { used: number; cap: number };
    };
  };
  sendTimeOptimization: {
    wouldOptimize: boolean;
    targetHour?: number;
    reason: string;
  };
}

/**
 * Notification preview API.
 *
 * Renders exactly what a user would receive across all enabled channels,
 * using their real preferences, language, and A/B variant assignment --
 * but never persists a notification record, never queues to RabbitMQ,
 * and never calls a delivery provider.
 *
 * Used by support/QA to debug "why did this user get this message" or
 * "what would this user see if we sent X" without side effects.
 */
@Injectable()
export class NotificationPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templateEngine: TemplateEngineService,
    private readonly abTesting: AbTestingService,
    private readonly sendTimeOptimization: SendTimeOptimizationService,
    private readonly dndClassifier: DndClassifierService,
    private readonly frequencyCap: FrequencyCapService,
    private readonly preferenceResolver: PreferenceResolverService,
  ) {}

  async preview(
    userId: string,
    eventType: string,
    payload: Record<string, unknown>,
    localeOverride?: string,
  ): Promise<NotificationPreview> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const locale = (localeOverride ??
      user.language.toLowerCase()) as SupportedLocale;
    const eventTypeTyped = eventType as EventType;

    const variant = await this.abTesting.resolveVariant(userId, eventType);
    const classification = this.dndClassifier.classify(eventTypeTyped);

    const resolvedPreference = await this.preferenceResolver.resolve(
      userId,
      eventTypeTyped,
      user.accountType,
    );

    const channelPreviews: ChannelPreview[] = [];

    for (const channel of ALL_CHANNELS) {
      const enabled = resolvedPreference.channels.includes(channel);

      if (!enabled) {
        channelPreviews.push({
          channel,
          enabled: false,
          body: null,
          renderError: null,
        });
        continue;
      }

      try {
        const rendered = await this.templateEngine.render(
          variant.templateId,
          channel,
          {
            userId,
            userName: user.name,
            language: locale,
            timezone: user.timezone,
            // Was missing entirely, so buildContext() silently defaulted to
            // INR for every preview regardless of the user's market — the
            // real send path (notification-engine.service.ts) always passes
            // this; preview must match it to show what would actually send.
            currency: getMarketProfile(user.market).currency,
            payload,
          },
        );

        channelPreviews.push({
          channel,
          enabled: true,
          subject: rendered.subject,
          title: rendered.title,
          body: rendered.body,
          renderError: null,
        });
      } catch (err) {
        channelPreviews.push({
          channel,
          enabled: true,
          body: null,
          renderError: (err as Error).message,
        });
      }
    }

    const capUsage = await this.frequencyCap.getUsage(
      userId,
      'sms',
      eventTypeTyped,
    );

    const stoDecision = await this.sendTimeOptimization.decide(
      userId,
      eventTypeTyped,
      Priority.MEDIUM,
      user.timezone,
    );

    return {
      userId,
      eventType,
      classification,
      templateId: variant.templateId,
      templateVersion: variant.version,
      isAbVariant: variant.isAbVariant,
      channels: channelPreviews,
      compliance: {
        wouldBeDndChecked: classification === 'PROMOTIONAL',
        capUsage,
      },
      sendTimeOptimization: {
        wouldOptimize: stoDecision.optimize,
        targetHour: stoDecision.targetHour,
        reason: stoDecision.reason,
      },
    };
  }
}
