// src/preferences/preferences.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { ValidationFailedException } from '../shared/pipes/validation.pipe';
import { PreferenceCacheService } from './preference-cache.service';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
import { REGULATORY_MANDATORY_EVENTS } from '../shared/constants/event-types';
import { ALL_CHANNELS } from '../shared/constants/channels';

const MIN_QUIET_WINDOW_MINUTES = 6 * 60;

@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PreferenceCacheService,
  ) {}

  async getPreferences(userId: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        language: true,
        timezone: true,
        quietHoursStart: true,
        quietHoursEnd: true,
      },
    });

    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const prefs = await this.prisma.userPreference.findMany({
      where: { userId },
      orderBy: [{ eventCategory: 'asc' }, { channel: 'asc' }],
    });

    // Group by category for API response
    const byCategory: Record<
      string,
      { channels: Record<string, boolean>; digestMode: string }
    > = {};

    for (const pref of prefs) {
      const key = pref.eventCategory;
      if (!byCategory[key]) {
        byCategory[key] = { channels: {}, digestMode: pref.digestMode };
      }
      byCategory[key].channels[pref.channel] = pref.enabled;
    }

    // Build regulatory overrides section
    const regulatoryOverrides = REGULATORY_MANDATORY_EVENTS.map((et) => ({
      eventType: et,
      channels: this.getRegulatoryChannels(et),
      cannotDisable: true,
    }));

    return {
      userId,
      globalPreferences: {
        quietHours: {
          start: user.quietHoursStart,
          end: user.quietHoursEnd,
          timezone: user.timezone,
        },
        language: user.language.toLowerCase(),
        // No global digest is stored; per-category digest modes carry the setting.
        digestMode: 'none',
      },
      categoryPreferences: Object.entries(byCategory).map(
        ([category, data]) => ({
          category,
          channels: data.channels,
          digestMode: data.digestMode.toLowerCase(),
        }),
      ),
      regulatoryOverrides,
      updatedAt: new Date().toISOString(),
    };
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferenceDto,
  ): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) throw new NotFoundException(`User ${userId} not found`);

    await this.assertQuietWindow(userId, dto);

    // Upsert preference for each channel
    const upsertOps = ALL_CHANNELS.map((channel) => {
      const enabled = dto.channels[channel] ?? true;

      return this.prisma.userPreference.upsert({
        where: {
          userId_eventCategory_channel: {
            userId,
            eventCategory: dto.category,
            channel,
          },
        },
        create: {
          userId,
          eventCategory: dto.category,
          eventType: dto.eventType ?? null,
          channel,
          enabled,
          digestMode: dto.digestMode ?? 'IMMEDIATE',
        },
        update: {
          enabled,
          digestMode: dto.digestMode ?? 'IMMEDIATE',
          updatedAt: new Date(),
        },
      });
    });

    await this.prisma.$transaction(upsertOps);

    // Update quiet hours if provided
    if (dto.quietHoursStart || dto.quietHoursEnd) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.quietHoursStart && { quietHoursStart: dto.quietHoursStart }),
          ...(dto.quietHoursEnd && { quietHoursEnd: dto.quietHoursEnd }),
        },
      });
    }

    // Invalidate cache immediately
    await this.cache.invalidate(userId);

    this.logger.log(
      `Preferences updated for user ${userId} category ${dto.category}`,
    );

    // Build warnings for disabled regulatory channels
    const warnings = this.buildWarnings(dto);

    return {
      status: 'updated',
      category: dto.category,
      warnings,
      cacheInvalidated: true,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Spec A6.3: "a minimum 6-hour enforced quiet window". A shorter window would
   * defeat the point of quiet hours; a 24-hour window would silence the user
   * entirely, so the window is also capped below a full day.
   */
  private async assertQuietWindow(
    userId: string,
    dto: UpdatePreferenceDto,
  ): Promise<void> {
    if (!dto.quietHoursStart && !dto.quietHoursEnd) return;

    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { quietHoursStart: true, quietHoursEnd: true },
    });
    const start = dto.quietHoursStart ?? current?.quietHoursStart ?? '21:00';
    const end = dto.quietHoursEnd ?? current?.quietHoursEnd ?? '08:00';

    const minutes = (t: string): number => {
      const [h = 0, m = 0] = t.split(':').map(Number);
      return h * 60 + m;
    };
    // wrap past midnight: 22:00 → 07:00 is 9h
    const length = (minutes(end) - minutes(start) + 1440) % 1440;

    if (length < MIN_QUIET_WINDOW_MINUTES) {
      throw new ValidationFailedException(
        [
          {
            field: dto.quietHoursStart
              ? 'quiet_hours_start'
              : 'quiet_hours_end',
            error: `quiet hours must span at least 6 hours (got ${Math.floor(length / 60)}h${length % 60 ? ` ${length % 60}m` : ''})`,
          },
        ],
        'Quiet hours window is too short',
      );
    }
  }

  private buildWarnings(dto: UpdatePreferenceDto): string[] {
    const warnings: string[] = [];

    if (dto.channels.email === false) {
      warnings.push(
        `Email disabled for ${dto.category} — you will not receive ` +
          `email notifications for this category. Regulatory notifications ` +
          `will still be delivered via mandatory channels.`,
      );
    }

    if (dto.channels.sms === false) {
      warnings.push(
        `SMS disabled for ${dto.category} — note that some regulatory ` +
          `notifications (e.g. margin calls) require SMS delivery and ` +
          `cannot be disabled.`,
      );
    }

    return warnings;
  }

  private getRegulatoryChannels(eventType: string): string[] {
    const map: Record<string, string[]> = {
      'RISK-001': ['sms', 'push'],
      'RISK-002': ['sms', 'push', 'email'],
      'RISK-003': ['sms', 'push', 'email'],
      'TXNX-001': ['sms', 'push', 'email'],
      'TXNX-002': ['sms', 'push', 'email'],
      'REGX-001': ['sms', 'email', 'push'],
    };
    return map[eventType] ?? [];
  }
}
