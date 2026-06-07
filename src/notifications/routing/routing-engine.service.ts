// src/notifications/routing/routing-engine.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PreferenceResolverService } from '../../preferences/preference-resolver.service';
import { DndService } from '../../compliance/dnd/dnd.service';
import { FrequencyCapService } from '../../compliance/frequency-cap/frequency-cap.service';
import { QuietHoursService } from '../../compliance/quiet-hours/quiet-hours.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { type EventType } from '../../shared/constants/event-types';
import { type Channel } from '../../shared/constants/channels';
import {
  CHANNEL_COST_PAISA,
  CHANNEL_DELIVERY_RATE,
} from '../../shared/constants/channels';
import { CRITICAL_EVENTS } from '../../shared/constants/event-types';

export interface RoutingDecision {
  channels: Channel[];
  suppressedChannels: Array<{ channel: Channel; reason: string }>;
  quietHoursDelay?: { deliverAt: string };
  regulatoryOverride: boolean;
}

interface UserContext {
  userId: string;
  phone: string;
  accountType: string;
  timezone: string;
}

/**
 * Weighted scoring routing engine.
 *
 * For each candidate channel, a score is computed:
 *
 * Score = (regulatory × 1000) + (preference × 400) +
 *         (deliveryRate × 300) + (costEfficiency × 200) +
 *         (channelHealth × 100)
 *
 * Regulatory weight (1000) is intentionally much larger than all others
 * combined — regulatory channels cannot be outscored.
 *
 * Processing order:
 * 1. Resolve preferences (what channels does this user want?)
 * 2. DND check (SMS only — last moment before dispatch)
 * 3. Frequency cap check
 * 4. Quiet hours check
 * 5. Score and rank surviving channels
 */
@Injectable()
export class RoutingEngineService {
  private readonly logger = new Logger(RoutingEngineService.name);

  constructor(
    private readonly preferenceResolver: PreferenceResolverService,
    private readonly dndService: DndService,
    private readonly frequencyCapService: FrequencyCapService,
    private readonly quietHoursService: QuietHoursService,
    private readonly prometheus: PrometheusService,
  ) {}

  async route(
    eventType: EventType,
    userContext: UserContext,
    priority: number,
  ): Promise<RoutingDecision> {
    const suppressedChannels: Array<{ channel: Channel; reason: string }> = [];

    // Step 1 — Resolve preferences
    const resolved = await this.preferenceResolver.resolve(
      userContext.userId,
      eventType,
      userContext.accountType,
    );

    let candidateChannels = resolved.channels;

    // Step 2 — DND check (SMS only)
    const channelsAfterDnd: Channel[] = [];
    for (const channel of candidateChannels) {
      const dndResult = await this.dndService.check(
        userContext.userId,
        userContext.phone,
        eventType,
        channel,
      );

      if (!dndResult.allowed) {
        suppressedChannels.push({ channel, reason: dndResult.reason });
        this.prometheus.recordDndBlock('PROMOTIONAL');
      } else {
        channelsAfterDnd.push(channel);
      }
    }
    candidateChannels = channelsAfterDnd;

    // Step 3 — Frequency cap check
    const channelsAfterCap: Channel[] = [];
    for (const channel of candidateChannels) {
      const capResult = await this.frequencyCapService.check(
        userContext.userId,
        eventType,
        channel,
      );

      if (capResult.capped) {
        suppressedChannels.push({ channel, reason: capResult.reason });
        this.prometheus.recordCapHit('routing', eventType);
      } else {
        channelsAfterCap.push(channel);
      }
    }
    candidateChannels = channelsAfterCap;

    // Step 4 — Quiet hours check
    const quietResult = await this.quietHoursService.check(
      userContext.userId,
      eventType,
    );

    if (quietResult.suppressed) {
      // CRITICAL events already bypass in QuietHoursService
      // If we reach here with suppressed=true, it is a non-critical event
      return {
        channels: [],
        suppressedChannels: candidateChannels.map((ch) => ({
          channel: ch,
          reason: 'QUIET_HOURS',
        })),
        quietHoursDelay: { deliverAt: quietResult.deliverAt },
        regulatoryOverride: resolved.regulatoryOverride,
      };
    }

    // Step 5 — Score and rank remaining channels
    const scoredChannels = this.scoreChannels(
      candidateChannels,
      eventType,
      priority,
    );

    this.logger.debug(
      `Routing decision for user ${userContext.userId} event ${eventType}: ` +
        `${scoredChannels.map((c) => c.channel).join(', ')}`,
    );

    return {
      channels: scoredChannels.map((c) => c.channel),
      suppressedChannels,
      regulatoryOverride: resolved.regulatoryOverride,
    };
  }

  // ── Weighted scoring algorithm ────────────────────────────────────

  private scoreChannels(
    channels: Channel[],
    eventType: EventType,
    priority: number,
  ): Array<{ channel: Channel; score: number }> {
    const isCritical = CRITICAL_EVENTS.includes(eventType);

    return channels
      .map((channel) => {
        const deliveryRate = CHANNEL_DELIVERY_RATE[channel] ?? 0.5;
        const costPaisa = CHANNEL_COST_PAISA[channel] ?? 100;

        // Cost efficiency: cheaper channels score higher (normalized 0-1)
        // Max cost is IVR at ~300 paisa, min is 0 (push/in-app)
        const maxCost = 300;
        const costEfficiency = 1 - costPaisa / maxCost;

        // Regulatory weight: 1000 if CRITICAL, 0 otherwise
        const regulatoryWeight = isCritical ? 1000 : 0;

        // Preference weight: SMS and push score higher for urgent events
        const preferenceWeight =
          priority <= 2 && ['sms', 'push'].includes(channel) ? 400 : 200;

        const score =
          regulatoryWeight +
          preferenceWeight +
          deliveryRate * 300 +
          costEfficiency * 200;

        return { channel, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}
