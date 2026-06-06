// src/delivery/retry/retry-worker.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { REDIS_KEYS } from '../../shared/constants/redis-keys';
import { Priority, RETRY_CONFIG } from '../../shared/constants/priorities';
import { NotificationStatus } from '../../shared/constants/notification-states';
import { calculateRetryDelay } from '../../shared/utils/retry.util';

/**
 * Retry worker using Redis sorted sets.
 *
 * Architecture:
 * - Score = unix timestamp when retry should fire
 * - Member = notificationId
 * - Worker polls every 5 seconds for members with score <= now
 * - Exponential backoff with jitter prevents thundering herd on recovery
 *
 * Separate queues per priority level ensure CRITICAL retries
 * are always processed before LOW retries.
 */
@Injectable()
export class RetryWorkerService implements OnModuleInit {
  private readonly logger = new Logger(RetryWorkerService.name);
  private isRunning = false;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Poll every 5 seconds
    this.intervalHandle = setInterval(() => {
      void this.processDueRetries();
    }, 5_000);

    this.logger.log('Retry worker started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isRunning = false;
    this.logger.log('Retry worker stopped');
  }

  /**
   * Schedules a notification for retry.
   * Called by the delivery service after a failed send.
   */
  async scheduleRetry(
    notificationId: string,
    attempt: number,
    priority: Priority,
  ): Promise<boolean> {
    const config = RETRY_CONFIG[priority];

    if (attempt > config.maxRetries) {
      this.logger.warn(
        `Notification ${notificationId} exceeded max retries (${config.maxRetries}) — moving to DLQ`,
      );
      return false; // signal caller to move to DLQ
    }

    const delayMs = calculateRetryDelay({
      baseDelayMs: config.baseDelayMs,
      maxDelayMs: config.maxDelayMs,
      attempt,
    });

    const retryAt = Date.now() + delayMs;

    await this.redis.zadd(
      REDIS_KEYS.retryQueue(priority),
      retryAt,
      notificationId,
    );

    this.logger.debug(
      `Notification ${notificationId} scheduled for retry in ${delayMs}ms (attempt ${attempt})`,
    );

    return true;
  }

  /**
   * Processes all notifications whose retry time has arrived.
   */
  private async processDueRetries(): Promise<void> {
    const priorities = [
      Priority.CRITICAL,
      Priority.HIGH,
      Priority.MEDIUM,
      Priority.LOW,
    ];

    for (const priority of priorities) {
      await this.processPriorityQueue(priority);
    }
  }

  private async processPriorityQueue(priority: Priority): Promise<void> {
    const queueKey = REDIS_KEYS.retryQueue(priority);
    const now = Date.now();

    // Get up to 50 due notifications
    const dueIds = await this.redis.zrangebyscore(queueKey, 0, now, 50);

    if (dueIds.length === 0) return;

    for (const notificationId of dueIds) {
      try {
        await this.requeueNotification(notificationId);
        await this.redis.zrem(queueKey, notificationId);
      } catch (err) {
        this.logger.error(
          `Failed to requeue notification ${notificationId}: ${(err as Error).message}`,
        );
      }
    }

    if (dueIds.length > 0) {
      this.logger.debug(
        `Requeued ${dueIds.length} priority-${priority} notifications for retry`,
      );
    }
  }

  private async requeueNotification(notificationId: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: NotificationStatus.RETRYING,
        updatedAt: new Date(),
      },
    });

    // State log entry
    await this.prisma.notificationStateLog.create({
      data: {
        notificationId,
        fromStatus: NotificationStatus.FAILED,
        toStatus: NotificationStatus.RETRYING,
        actor: 'retry_worker',
        metadata: { requeuedAt: new Date().toISOString() },
      },
    });
  }
}
