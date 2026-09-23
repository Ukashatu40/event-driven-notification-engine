// src/shared/jobs/partition-maintenance.job.ts
/**
 * Partition Maintenance Job — spec Section A8.1 / Day 2
 *
 * `notifications` is partitioned by month on "createdAt". This job makes sure
 * next months' partitions exist BEFORE any row needs them, by calling the
 * idempotent ensure_notification_partitions() SQL function (see migration
 * 20260921000001_partition_notifications).
 *
 * Runs once at startup (so a fresh or long-idle deployment is immediately
 * safe) and daily at 01:00 UTC. It looks three months ahead, so a job outage
 * of up to ~3 months is survivable; rows that miss a partition land in
 * notifications_default rather than failing the insert.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/database/prisma.service';

const MONTHS_AHEAD = 3;

@Injectable()
export class PartitionMaintenanceJob implements OnModuleInit {
  private readonly logger = new Logger(PartitionMaintenanceJob.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.ensurePartitions();
  }

  @Cron('0 1 * * *', { name: 'partition-maintenance', timeZone: 'UTC' })
  async ensurePartitions(): Promise<number> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ created: number }>>`
        SELECT ensure_notification_partitions(0, ${MONTHS_AHEAD}) AS created
      `;
      const created = Number(rows[0]?.created ?? 0);

      if (created > 0) {
        this.logger.log(`Created ${created} notification partition(s)`);
      }
      return created;
    } catch (err) {
      // Not fatal to startup (the DEFAULT partition still accepts inserts),
      // but it must be visible: a failing job means partitions will run out.
      this.logger.error(
        `Partition maintenance failed: ${(err as Error).message}`,
      );
      return 0;
    }
  }
}
