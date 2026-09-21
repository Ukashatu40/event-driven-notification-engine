// src/notifications/routing/routing-engine.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PreferenceResolverService } from '../../preferences/preference-resolver.service';
import { FrequencyCapService } from '../../compliance/frequency-cap/frequency-cap.service';
import { QuietHoursService } from '../../compliance/quiet-hours/quiet-hours.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { type EventType } from '../../shared/constants/event-types';
import { type Channel } from '../../shared/constants/channels';
import {
  CHANNEL_COST_PAISA,
  CHANNEL_DELIVERY_RATE,
} from '../../shared/constants/channels';
import {
  CRITICAL_EVENTS,
  REGULATORY_MANDATORY_EVENTS,
} from '../../shared/constants/event-types';

export interface RoutingDecision {
  channels: Channel[];
  suppressedChannels: Array<{ channel: Channel; reason: string }>;
  quietHoursDelay?: { deliverAt: string };
  regulatoryOverride: boolean;
  /**
   * Policies a CRITICAL event skipped. Recorded in the notification's state log
   * so every bypass is auditable (spec A6.2 / A6.3: "with an audit log entry").
   */
  policyBypasses?: string[];
  /**
   * Set when the user asked for this category as an hourly/daily digest. The
   * notification is held and delivered inside a digest instead of on its own.
   */
  digest?: { mode: 'HOURLY' | 'DAILY' };
}

interface UserContext {
  userId: string;
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
 * 2. Frequency cap check
 * 3. Quiet hours check
 * 4. Score and rank surviving channels
 *
 * DND is enforced at dispatch, not here (ADR-004).
 */
@Injectable()
export class RoutingEngineService {
  private readonly logger = new Logger(RoutingEngineService.name);

  constructor(
    private readonly preferenceResolver: PreferenceResolverService,
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

    // Digest preference (spec Day 5). Only for events that are neither CRITICAL
    // nor regulator-mandated: a margin call or a trade confirmation is never
    // held back to be batched, whatever the user picked. Caps and quiet hours are
    // deliberately skipped — the digest itself is what gets sent later, and it
    // respects quiet hours when it is flushed.
    const digestable =
      !CRITICAL_EVENTS.includes(eventType) &&
      !REGULATORY_MANDATORY_EVENTS.includes(eventType);
    if (
      digestable &&
      candidateChannels.length > 0 &&
      (resolved.digestMode === 'HOURLY' || resolved.digestMode === 'DAILY')
    ) {
      return {
        channels: [],
        suppressedChannels: [],
        regulatoryOverride: false,
        digest: { mode: resolved.digestMode },
      };
    }

    // DND is deliberately NOT evaluated here. It is checked at dispatch, the
    // last moment before the SMS leaves the system (ADR-004 / DeliveryService).

    // Step 2 — Frequency cap check
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

    // Step 3 — Quiet hours check
    // Nothing left after the caps → nothing to defer; the engine records the
    // notification as CAPPED instead of parking an empty send in the quiet queue.
    const quietResult =
      candidateChannels.length > 0
        ? await this.quietHoursService.check(userContext.userId, eventType)
        : { suppressed: false as const };

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

    // Step 4 — Score and rank remaining channels
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
      ...(CRITICAL_EVENTS.includes(eventType) && {
        policyBypasses: ['frequency_cap', 'quiet_hours'],
      }),
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
