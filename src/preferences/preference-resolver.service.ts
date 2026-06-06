// src/preferences/preference-resolver.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PreferenceCacheService } from './preference-cache.service';
import {
  REGULATORY_MANDATORY_EVENTS,
  EventType,
} from '../shared/constants/event-types';
import { Channel, ALL_CHANNELS } from '../shared/constants/channels';

export interface ResolvedPreference {
  channels: Channel[];
  digestMode: string;
  quietHoursOverride: boolean;
  regulatoryOverride: boolean;
}

interface CachedPreferences {
  byCategory: Record<
    string,
    {
      channels: Record<string, boolean>;
      digestMode: string;
    }
  >;
  resolvedAt: string;
}

/**
 * 4-Layer preference hierarchy resolver (spec Section A5.1).
 *
 * Layer 1 — System defaults:  all CRITICAL events → SMS + Push
 * Layer 2 — Segment overrides: premium users get WhatsApp for all events
 * Layer 3 — User explicit:    user-configured per-category settings
 * Layer 4 — Regulatory override: SEBI-mandated channels CANNOT be disabled
 *
 * Resolution is deterministic — same inputs always produce same output.
 * This is critical for debugging (see Slack case study C6).
 *
 * Performance target: < 2ms per resolution (achieved via Redis cache).
 */
@Injectable()
export class PreferenceResolverService {
  private readonly logger = new Logger(PreferenceResolverService.name); // added for logging cache hits/misses and overrides

  // Layer 1: system defaults per event category
  private readonly SYSTEM_DEFAULTS: Record<string, Channel[]> = {
    RISK: ['sms', 'push', 'in_app'],
    TXNX: ['sms', 'push', 'email'],
    SIPX: ['push', 'email'],
    MKTX: ['push', 'in_app'],
    REGX: ['email', 'sms'],
  };

  // Layer 4: regulatory mandatory channels per event type
  // These are added regardless of user preference
  private readonly REGULATORY_CHANNELS: Partial<Record<EventType, Channel[]>> =
    {
      'RISK-001': ['sms', 'push'],
      'RISK-002': ['sms', 'push', 'email'],
      'RISK-003': ['sms', 'push', 'email'],
      'MKTX-002': ['sms', 'push'],
      'TXNX-001': ['sms', 'push', 'email'],
      'TXNX-002': ['sms', 'push', 'email'],
      'TXNX-003': ['push', 'sms'],
      'TXNX-005': ['sms', 'push'],
      'SIPX-002': ['sms', 'email'],
      'SIPX-003': ['sms', 'push', 'email'],
      'REGX-001': ['sms', 'email', 'push'],
      'REGX-003': ['email'],
    };

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PreferenceCacheService,
  ) {}

  async resolve(
    userId: string,
    eventType: EventType,
    accountType: string,
  ): Promise<ResolvedPreference> {
    const category = eventType.split('-')[0] ?? 'TXNX';
    const isRegulatory = REGULATORY_MANDATORY_EVENTS.includes(eventType);

    // Layer 4 — Regulatory override (evaluated first, non-negotiable)
    const regulatoryChannels = this.REGULATORY_CHANNELS[eventType] ?? [];
    const regulatoryOverride = regulatoryChannels.length > 0;

    // Layer 1 — System defaults
    const defaultChannels =
      this.SYSTEM_DEFAULTS[category] ?? (['push', 'in_app'] as Channel[]);

    // Layer 2 — Segment override (premium/HNI get WhatsApp)
    const segmentChannels = this.applySegmentOverride(
      defaultChannels,
      accountType,
    );

    // Layer 3 — User explicit preferences (from cache or DB)
    const userChannels = await this.applyUserPreferences(
      userId,
      category,
      eventType,
      segmentChannels,
    );

    // Merge: user preferences + regulatory mandatory channels
    // Regulatory channels are always ADDED, never removed by user prefs
    const mergedChannels = this.mergeChannels(userChannels, regulatoryChannels);

    return {
      channels: mergedChannels,
      digestMode: await this.resolveDigestMode(userId, category),
      quietHoursOverride: isRegulatory,
      regulatoryOverride,
    };
  }

  // ── Private layer implementations ─────────────────────────────────

  private applySegmentOverride(
    channels: Channel[],
    accountType: string,
  ): Channel[] {
    // Premium and HNI users get WhatsApp added by default
    if (['PREMIUM', 'HNI'].includes(accountType)) {
      return [...new Set([...channels, 'whatsapp' as Channel])];
    }
    return channels;
  }

  private async applyUserPreferences(
    userId: string,
    category: string,
    eventType: EventType,
    defaultChannels: Channel[],
  ): Promise<Channel[]> {
    this.logger.debug(
      `Resolving preferences for user ${userId}, event ${eventType} (category ${category})`,
    ); // log the resolution attempt
    // Try cache first
    const cached = await this.cache.get<CachedPreferences>(userId);

    let categoryPrefs: Record<string, boolean> | undefined;

    if (cached) {
      // Check event-type-specific preference first, then category-level
      categoryPrefs =
        cached.byCategory[eventType]?.channels ??
        cached.byCategory[category]?.channels;
    } else {
      // Cache miss — load from DB and cache
      const dbPrefs = await this.loadFromDb(userId);
      await this.cache.set(userId, dbPrefs);

      categoryPrefs =
        dbPrefs.byCategory[eventType]?.channels ??
        dbPrefs.byCategory[category]?.channels;
    }

    if (!categoryPrefs) return defaultChannels;

    // Apply user's enabled/disabled preferences on top of defaults
    return ALL_CHANNELS.filter((channel) => {
      const userSetting = categoryPrefs![channel];
      // If user has no explicit setting, fall back to default
      if (userSetting === undefined) {
        return defaultChannels.includes(channel);
      }
      return userSetting === true;
    });
  }

  private async loadFromDb(userId: string): Promise<CachedPreferences> {
    const prefs = await this.prisma.userPreference.findMany({
      where: { userId },
    });

    const byCategory: CachedPreferences['byCategory'] = {};

    for (const pref of prefs) {
      const key = pref.eventType ?? pref.eventCategory;
      if (!byCategory[key]) {
        byCategory[key] = {
          channels: {},
          digestMode: pref.digestMode,
        };
      }
      byCategory[key]!.channels[pref.channel] = pref.enabled;
    }

    return { byCategory, resolvedAt: new Date().toISOString() };
  }

  private mergeChannels(
    userChannels: Channel[],
    regulatoryChannels: Channel[],
  ): Channel[] {
    return [...new Set([...userChannels, ...regulatoryChannels])];
  }

  private async resolveDigestMode(
    userId: string,
    category: string,
  ): Promise<string> {
    const cached = await this.cache.get<CachedPreferences>(userId);
    return cached?.byCategory[category]?.digestMode ?? 'IMMEDIATE';
  }
}
