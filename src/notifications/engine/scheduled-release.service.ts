// src/notifications/engine/scheduled-release.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { REDIS_KEYS } from '../../shared/constants/redis-keys';
import { type Channel } from '../../shared/constants/channels';
import { NotificationEngineService } from './notification-engine.service';
import { QuietHoursService } from '../../compliance/quiet-hours/quiet-hours.service';

interface ScheduledEntry {
  id: string;
  channels: Channel[];
  /** quiet = held by quiet hours; sto = delayed for send-time optimisation. */
  kind?: 'quiet' | 'sto';
  userId?: string;
}

/**
 * Releases notifications that were deferred by quiet hours or send-time
 * optimisation once their release time arrives.
 *
 * Each due member is claimed with ZREM before it is processed. ZREM returns 1
 * for exactly one caller, so several app replicas polling the same set never
 * dispatch the same notification twice.
 */
@Injectable()
export class ScheduledReleaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledReleaseService.name);
  private handle: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly redis: RedisService,
    private readonly engine: NotificationEngineService,
    private readonly config: ConfigService,
    private readonly quietHours: QuietHoursService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('SCHEDULED_RELEASE_ENABLED') === 'false')
      return;

    this.handle = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void this.releaseDue().finally(() => {
        this.polling = false;
      });
    }, 5_000);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  async releaseDue(): Promise<number> {
    const due = await this.redis.zrangebyscore(
      REDIS_KEYS.scheduledRelease,
      0,
      Date.now(),
      50,
    );

    // Snapshot each user's quiet queue BEFORE releasing anything: the decision
    // "more than 5 piled up overnight → one digest" must not change halfway
    // through the batch as items leave the queue.
    const depth = new Map<string, number>();
    for (const member of due) {
      try {
        const e = JSON.parse(member) as ScheduledEntry;
        if (e.kind === 'quiet' && e.userId && !depth.has(e.userId)) {
          depth.set(e.userId, await this.quietHours.getQueueDepth(e.userId));
        }
      } catch {
        // an unparseable member is handled (and rescheduled) below
      }
    }

    let released = 0;
    for (const member of due) {
      const claimed = await this.redis
        .getClient()
        .zrem(REDIS_KEYS.scheduledRelease, member);
      if (claimed === 0) continue; // another replica got it

      try {
        const entry = JSON.parse(member) as ScheduledEntry;
        const pileUp = entry.userId ? (depth.get(entry.userId) ?? 0) : 0;

        if (
          entry.kind === 'quiet' &&
          this.quietHours.shouldBatchIntoDig(pileUp)
        ) {
          await this.engine.deferToDigest(entry.id);
        } else {
          await this.engine.resume(entry.id, entry.channels);
        }
        released++;
      } catch (err) {
        // Put it back so the release is retried rather than lost.
        this.logger.error(
          `Scheduled release failed (${(err as Error).message}) — rescheduling in 30s`,
        );
        await this.redis.zadd(
          REDIS_KEYS.scheduledRelease,
          Date.now() + 30_000,
          member,
        );
      }
    }

    if (released > 0) {
      this.logger.log(`Released ${released} deferred notification(s)`);
    }
    return released;
  }
}
