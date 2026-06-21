// src/shared/jobs/data-retention.job.ts
/**
 * Data Retention Job — spec Section A10.2
 *
 * "Implement data retention policies: notification content older than 90 days
 * should have personalisation_data scrubbed while retaining metadata for analytics"
 *
 * Runs daily at 02:00 UTC (outside market hours) to minimise DB load.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/database/prisma.service';

@Injectable()
export class DataRetentionJob {
  private readonly logger = new Logger(DataRetentionJob.name);
  private static readonly RETENTION_DAYS = 90;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Daily at 02:00 UTC — scrub personalisation_data from notifications
   * older than 90 days. Metadata (event_type, channel, status, timestamps,
   * cost_paisa) is retained for analytics as permitted by legitimate interest.
   */
  @Cron('0 2 * * *', { name: 'data-retention-scrub', timeZone: 'UTC' })
  async scrubExpiredPersonalisationData(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DataRetentionJob.RETENTION_DAYS);

    this.logger.log(
      `[DataRetention] Running 90-day scrub. Cutoff: ${cutoff.toISOString()}`,
    );

    try {
      const result = await this.prisma.notification.updateMany({
        where: {
          createdAt: { lt: cutoff },
          // Only scrub if not already scrubbed (check for retention marker)
          NOT: {
            metadata: {
              path: ['retention_scrubbed'],
              equals: true,
            },
          },
        },
        data: {
          // Replace personalisation_data (PII) with a retention marker
          personalisationData: {
            retention_scrubbed: true,
            scrubbed_at: new Date().toISOString(),
            retention_policy_days: DataRetentionJob.RETENTION_DAYS,
          },
          // Null out rendered content (also contains PII)
          renderedContent: null,
        } as any,
      });

      this.logger.log(
        `[DataRetention] Scrubbed ${result.count} notifications older than ${DataRetentionJob.RETENTION_DAYS} days`,
      );
    } catch (err) {
      this.logger.error(
        `[DataRetention] Scrub failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      // Do not rethrow — job must not crash the process
    }
  }

  /**
   * Weekly on Sunday at 03:00 UTC — delete orphaned DLQ entries
   * older than 180 days that have been resolved.
   */
  @Cron('0 3 * * 0', { name: 'dlq-cleanup', timeZone: 'UTC' })
  async cleanupResolvedDlqEntries(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 180);

    try {
      const result = await this.prisma.deadLetterQueue.deleteMany({
        where: {
          resolved: true,
          resolvedAt: { lt: cutoff },
        },
      });

      this.logger.log(
        `[DataRetention] Deleted ${result.count} resolved DLQ entries older than 180 days`,
      );
    } catch (err) {
      this.logger.error(
        `[DataRetention] DLQ cleanup failed: ${(err as Error).message}`,
      );
    }
  }
}
