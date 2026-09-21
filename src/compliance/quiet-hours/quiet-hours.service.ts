// src/compliance/quiet-hours/quiet-hours.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { REDIS_KEYS } from '../../shared/constants/redis-keys';
import { CRITICAL_EVENTS, EventType } from '../../shared/constants/event-types';

export type QuietHoursResult =
  | { suppressed: false }
  | {
      suppressed: true;
      reason: string;
      deliverAt: string;
    };

/**
 * Quiet hours enforcement with per-user timezone resolution.
 *
 * Default quiet hours: 21:00 – 08:00 in user's IANA timezone.
 * CRITICAL events bypass quiet hours (with audit log entry).
 * Queued notifications are held in a Redis sorted set,
 * scored by the unix timestamp of when they should be delivered.
 * A scheduler picks them up at the start of the active window.
 *
 * If a user accumulates 5+ queued notifications,
 * they are batched into a single morning digest.
 */
@Injectable()
export class QuietHoursService {
  private readonly logger = new Logger(QuietHoursService.name);
  private readonly DIGEST_THRESHOLD = 5;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async check(userId: string, eventType: EventType): Promise<QuietHoursResult> {
    // CRITICAL events bypass quiet hours
    if (CRITICAL_EVENTS.includes(eventType)) {
      return { suppressed: false };
    }

    return this.checkWindow(userId);
  }

  /** Is the user inside their quiet window right now? (No event-type bypass.) */
  async checkWindow(userId: string): Promise<QuietHoursResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        timezone: true,
        quietHoursStart: true,
        quietHoursEnd: true,
      },
    });

    if (!user) return { suppressed: false };

    const isQuiet = this.isWithinQuietHours(
      user.timezone,
      user.quietHoursStart,
      user.quietHoursEnd,
    );

    if (!isQuiet) return { suppressed: false };

    const deliverAt = this.getNextActiveWindowStart(
      user.timezone,
      user.quietHoursEnd,
    );

    return {
      suppressed: true,
      reason: 'WITHIN_QUIET_HOURS',
      deliverAt: deliverAt.toISOString(),
    };
  }

  /**
   * Queues a notification for delivery after quiet hours.
   * Uses Redis sorted set with delivery timestamp as score.
   */
  async queue(
    userId: string,
    notificationId: string,
    deliverAt: Date,
  ): Promise<void> {
    await this.redis.zadd(
      REDIS_KEYS.quietQueue(userId),
      deliverAt.getTime(),
      notificationId,
    );

    this.logger.log(
      `Notification ${notificationId} queued for quiet hours delivery at ${deliverAt.toISOString()}`,
    );
  }

  /**
   * Returns all notifications ready for delivery (score <= now).
   * Called by the quiet hours scheduler every minute.
   */
  async getDueNotifications(userId: string): Promise<string[]> {
    return this.redis.zrangebyscore(
      REDIS_KEYS.quietQueue(userId),
      0,
      Date.now(),
      50, // process max 50 at a time
    );
  }

  async removeFromQueue(userId: string, notificationId: string): Promise<void> {
    await this.redis.zrem(REDIS_KEYS.quietQueue(userId), notificationId);
  }

  async getQueueDepth(userId: string): Promise<number> {
    return this.redis.zcount(REDIS_KEYS.quietQueue(userId), '-inf', '+inf');
  }

  /** Spec A6.3: batch "if count EXCEEDS 5" — six or more, not five. */
  shouldBatchIntoDig(queueDepth: number): boolean {
    return queueDepth > this.DIGEST_THRESHOLD;
  }

  // ── Time helpers ──────────────────────────────────────────────────

  private isWithinQuietHours(
    timezone: string,
    quietStart: string,
    quietEnd: string,
  ): boolean {
    const now = new Date();

    // Get current time in user's timezone
    const userTime = new Date(
      now.toLocaleString('en-US', { timeZone: timezone }),
    );

    const currentMinutes = userTime.getHours() * 60 + userTime.getMinutes();

    const [startH, startM] = quietStart.split(':').map(Number);
    const [endH, endM] = quietEnd.split(':').map(Number);

    const startMinutes = (startH ?? 21) * 60 + (startM ?? 0);
    const endMinutes = (endH ?? 8) * 60 + (endM ?? 0);

    // Handle overnight quiet hours (e.g. 21:00 – 08:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /** The next instant the user's quiet window ends (i.e. their "morning"). */
  nextActiveWindowStart(timezone: string, quietEnd: string): Date {
    return this.getNextActiveWindowStart(timezone, quietEnd);
  }

  private getNextActiveWindowStart(timezone: string, quietEnd: string): Date {
    const now = new Date();
    const [endH, endM] = quietEnd.split(':').map(Number);

    // Build a date representing the next quiet-hours end in user's timezone
    const userNow = new Date(
      now.toLocaleString('en-US', { timeZone: timezone }),
    );

    const target = new Date(userNow);
    target.setHours(endH ?? 8, endM ?? 0, 0, 0);

    // If target is in the past (i.e. end time was earlier today), push to tomorrow
    if (target <= userNow) {
      target.setDate(target.getDate() + 1);
    }

    // Convert back to UTC
    const offsetMs = now.getTime() - userNow.getTime();
    return new Date(target.getTime() + offsetMs);
  }
}
