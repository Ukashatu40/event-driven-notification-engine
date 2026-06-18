// src/notifications/preview/notification-preview.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { TemplateEngineService } from '../../templates/engine/template-engine.service';
import { PersonalisationService } from '../../templates/engine/personalisation.service';
import { AbTestingService } from '../../templates/engine/ab-testing.service';
import { SmsTruncationService } from '../../templates/engine/sms-truncation.service';
import { SendTimeOptimizationService } from '../engine/send-time-optimization.service';
import { DndClassifierService } from '../../compliance/dnd/dnd-classifier.service';
import { FrequencyCapService } from '../../compliance/frequency-cap/frequency-cap.service';
import { PreferenceResolverService } from '../../preferences/preference-resolver.service';
import { EventType } from '../../shared/constants/event-types';
import { Channel, ALL_CHANNELS } from '../../shared/constants/channels';
import { Priority } from '../../shared/constants/priorities';

export interface ChannelPreview {
  channel: Channel;
  enabled: boolean;
  rendered: string | null;
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
  private readonly logger = new Logger(NotificationPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templateEngine: TemplateEngineService,
    private readonly personalisation: PersonalisationService,
    private readonly abTesting: AbTestingService,
    private readonly smsTruncation: SmsTruncationService,
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
    this.logger.debug('Debugging');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const locale = localeOverride ?? user.language.toLowerCase();
    const eventTypeTyped = eventType as EventType;

    const variant = await this.abTesting.resolveVariant(userId, eventType);
    const classification = this.dndClassifier.classify(eventTypeTyped);

    const channelPreviews: ChannelPreview[] = [];

    for (const channel of ALL_CHANNELS) {
      const resolved = await this.preferenceResolver.resolve(
        userId,
        eventTypeTyped,
        channel,
      );

      if (!resolved.enabled) {
        channelPreviews.push({
          channel,
          enabled: false,
          rendered: null,
          renderError: null,
        });
        continue;
      }

      try {
        const personalisedPayload = await this.personalisation.enrich(
          payload,
          user,
          locale,
        );

        let rendered = await this.templateEngine.render(
          variant.templateId,
          channel,
          locale,
          personalisedPayload,
        );

        if (channel === 'sms') {
          rendered = this.smsTruncation.truncate(rendered);
        }

        channelPreviews.push({
          channel,
          enabled: true,
          rendered,
          renderError: null,
        });
      } catch (err) {
        channelPreviews.push({
          channel,
          enabled: true,
          rendered: null,
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
