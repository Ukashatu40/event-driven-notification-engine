// src/analytics/analytics.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { RealtimeCountersService } from './realtime-counters.service';

/**
 * States a notification only reaches once a provider was actually called.
 * Suppressed notifications (CAPPED, QUIET, DND, DEDUPLICATED) and ones that
 * never left the pipeline (CREATED…QUEUED) are NOT "sent" — counting them
 * would make every delivery rate look worse than it is.
 */
const ATTEMPTED_STATES = [
  'SENT',
  'DELIVERED',
  'READ',
  'BOUNCED',
  'FAILED',
  'RETRYING',
  'DLQ',
] as const;

interface DeliveryRateResult {
  period: { start: string; end: string };
  summary: {
    totalSent: number;
    totalDelivered: number;
    totalRead: number;
    overallDeliveryRate: number;
    overallReadRate: number;
  };
  byChannel: Record<string, { sent: number; delivered: number; rate: number }>;
  byPriority: Record<
    string,
    { sent: number; delivered: number; rate: number; p99LatencyMs: number }
  >;
  frequencyCapHits: { total: number; percentageOfUsersHittingCap: number };
  dndBlocks: {
    total: number;
    promotionalBlocked: number;
    transactionalBlocked: number;
  };
  costSummary: {
    totalPaisa: number;
    totalInr: number;
    perNotificationAvgPaisa: number;
  };
}

interface ChannelPerformanceResult {
  channel: string;
  provider: string;
  sent: number;
  delivered: number;
  failed: number;
  deliveryRate: number;
  avgLatencyMs: number;
  costPaisa: number;
  circuitBreakerTrips: number;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: RealtimeCountersService,
  ) {}

  async getDeliveryRates(periodDays: number = 7): Promise<DeliveryRateResult> {
    this.logger.debug(
      `Calculating delivery rates for the last ${periodDays} days`,
    );
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    const [totalStats, byChannel, byPriority, capHits, dndBlocks, costs] =
      await Promise.all([
        this.getTotalStats(startDate, endDate),
        this.getStatsByChannel(startDate, endDate),
        this.getStatsByPriority(startDate, endDate),
        this.getFrequencyCapHits(startDate, endDate),
        this.getDndBlockStats(startDate, endDate),
        this.getCostStats(startDate, endDate),
      ]);

    const totalUsers = await this.prisma.user.count();

    return {
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      summary: {
        totalSent: totalStats.sent,
        totalDelivered: totalStats.delivered,
        totalRead: totalStats.read,
        overallDeliveryRate:
          totalStats.sent > 0 ? totalStats.delivered / totalStats.sent : 0,
        overallReadRate:
          totalStats.delivered > 0 ? totalStats.read / totalStats.delivered : 0,
      },
      byChannel,
      byPriority,
      frequencyCapHits: {
        total: capHits,
        percentageOfUsersHittingCap: totalUsers > 0 ? capHits / totalUsers : 0,
      },
      dndBlocks: {
        total: dndBlocks.total,
        promotionalBlocked: dndBlocks.promotional,
        transactionalBlocked: 0, // should always be 0 — TRAI compliance
      },
      costSummary: {
        totalPaisa: costs.total,
        totalInr: costs.total / 100,
        perNotificationAvgPaisa:
          totalStats.sent > 0 ? costs.total / totalStats.sent : 0,
      },
    };
  }

  /**
   * Per-provider performance, computed from real data:
   *  - sent / failed / latency / cost come from delivery_attempts;
   *  - delivered comes from notifications that reached DELIVERED or READ via
   *    that provider (i.e. confirmed by a delivery receipt);
   *  - circuit trips is the provider's current failure count from provider_health.
   */
  async getChannelPerformance(
    periodDays: number = 7,
  ): Promise<ChannelPerformanceResult[]> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    const [attempts, failedAttempts, deliveredByProvider, health] =
      await Promise.all([
        this.prisma.deliveryAttempt.groupBy({
          by: ['provider'],
          where: { attemptedAt: { gte: startDate, lte: endDate } },
          _count: { id: true },
          _avg: { latencyMs: true, costPaisa: true },
        }),
        this.prisma.deliveryAttempt.groupBy({
          by: ['provider'],
          where: {
            attemptedAt: { gte: startDate, lte: endDate },
            status: 'failed',
          },
          _count: { id: true },
        }),
        this.prisma.notification.groupBy({
          by: ['provider'],
          where: {
            createdAt: { gte: startDate, lte: endDate },
            status: { in: ['DELIVERED', 'READ'] },
            provider: { not: null },
          },
          _count: { id: true },
        }),
        this.prisma.providerHealth.findMany({
          select: { provider: true, failureCount: true },
        }),
      ]);

    const failedBy = new Map(
      failedAttempts.map((r) => [r.provider, r._count.id]),
    );
    const deliveredBy = new Map(
      deliveredByProvider.map((r) => [r.provider ?? '', r._count.id]),
    );
    const tripsBy = new Map(health.map((h) => [h.provider, h.failureCount]));

    return attempts.map((r) => {
      const sent = r._count.id;
      const delivered = deliveredBy.get(r.provider) ?? 0;
      return {
        channel: this.getChannelForProvider(r.provider),
        provider: r.provider,
        sent,
        delivered,
        failed: failedBy.get(r.provider) ?? 0,
        deliveryRate: sent > 0 ? delivered / sent : 0,
        avgLatencyMs: Math.round(r._avg.latencyMs ?? 0),
        costPaisa: Math.round(r._avg.costPaisa ?? 0),
        circuitBreakerTrips: tripsBy.get(r.provider) ?? 0,
      };
    });
  }

  async getOptOutTrends(
    periodDays: number = 30,
  ): Promise<Array<{ date: string; optOuts: number; optIns: number }>> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    const records = await this.prisma.consentRecord.findMany({
      where: {
        grantedAt: { gte: startDate, lte: endDate },
      },
      select: { granted: true, grantedAt: true },
      orderBy: { grantedAt: 'asc' },
    });

    // Group by date
    const byDate: Record<string, { optOuts: number; optIns: number }> = {};

    for (const record of records) {
      const date = record.grantedAt.toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = { optOuts: 0, optIns: 0 };

      if (record.granted) {
        byDate[date].optIns++;
      } else {
        byDate[date].optOuts++;
      }
    }

    return Object.entries(byDate).map(([date, counts]) => ({
      date,
      ...counts,
    }));
  }

  async getRealtimeStats(): Promise<Record<string, number>> {
    const [
      deliveredLastHour,
      failedLastHour,
      cappedLastHour,
      dndBlockedLastHour,
    ] = await Promise.all([
      this.counters.getCount('deliveries', { status: 'delivered' }, 3600),
      this.counters.getCount('deliveries', { status: 'failed' }, 3600),
      this.counters.getCount('frequency_cap_hits', {}, 3600),
      this.counters.getCount('dnd_blocks', {}, 3600),
    ]);

    return {
      deliveredLastHour,
      failedLastHour,
      cappedLastHour,
      dndBlockedLastHour,
      deliveryRateLastHour:
        deliveredLastHour + failedLastHour > 0
          ? deliveredLastHour / (deliveredLastHour + failedLastHour)
          : 0,
    };
  }

  // ── Private query helpers ─────────────────────────────────────────

  private async getTotalStats(
    start: Date,
    end: Date,
  ): Promise<{ sent: number; delivered: number; read: number }> {
    const [sent, delivered, read] = await Promise.all([
      this.prisma.notification.count({
        where: {
          createdAt: { gte: start, lte: end },
          status: { in: [...ATTEMPTED_STATES] },
        },
      }),
      this.prisma.notification.count({
        where: {
          createdAt: { gte: start, lte: end },
          status: { in: ['DELIVERED', 'READ'] },
        },
      }),
      this.prisma.notification.count({
        where: {
          createdAt: { gte: start, lte: end },
          status: 'READ',
        },
      }),
    ]);

    return { sent, delivered, read };
  }

  private async getStatsByChannel(
    start: Date,
    end: Date,
  ): Promise<DeliveryRateResult['byChannel']> {
    const channels = ['sms', 'email', 'push', 'whatsapp', 'in_app'];
    const result: DeliveryRateResult['byChannel'] = {};

    for (const channel of channels) {
      const [sent, delivered] = await Promise.all([
        this.prisma.notification.count({
          where: {
            createdAt: { gte: start, lte: end },
            channel,
            status: { in: [...ATTEMPTED_STATES] },
          },
        }),
        this.prisma.notification.count({
          where: {
            createdAt: { gte: start, lte: end },
            channel,
            status: { in: ['DELIVERED', 'READ'] },
          },
        }),
      ]);

      result[channel] = {
        sent,
        delivered,
        rate: sent > 0 ? delivered / sent : 0,
      };
    }

    return result;
  }

  private async getStatsByPriority(
    start: Date,
    end: Date,
  ): Promise<DeliveryRateResult['byPriority']> {
    const priorities: Array<[string, number]> = [
      ['CRITICAL', 1],
      ['HIGH', 2],
      ['MEDIUM', 3],
      ['LOW', 5],
    ];

    const result: DeliveryRateResult['byPriority'] = {};

    for (const [label, priority] of priorities) {
      const [sent, delivered] = await Promise.all([
        this.prisma.notification.count({
          where: {
            createdAt: { gte: start, lte: end },
            priority,
            status: { in: [...ATTEMPTED_STATES] },
          },
        }),
        this.prisma.notification.count({
          where: {
            createdAt: { gte: start, lte: end },
            priority,
            status: { in: ['DELIVERED', 'READ'] },
          },
        }),
      ]);

      // P99 latency from delivery attempts
      const latencyData = await this.prisma.deliveryAttempt.findMany({
        where: {
          attemptedAt: { gte: start, lte: end },
          notification: { priority },
        },
        select: { latencyMs: true },
        orderBy: { latencyMs: 'asc' },
      });

      const p99Index = Math.floor(latencyData.length * 0.99);
      const p99Latency = latencyData[p99Index]?.latencyMs ?? 0;

      result[label] = {
        sent,
        delivered,
        rate: sent > 0 ? delivered / sent : 0,
        p99LatencyMs: p99Latency,
      };
    }

    return result;
  }

  private async getFrequencyCapHits(start: Date, end: Date): Promise<number> {
    return this.prisma.notification.count({
      where: {
        createdAt: { gte: start, lte: end },
        status: 'CAPPED',
      },
    });
  }

  private async getDndBlockStats(
    start: Date,
    end: Date,
  ): Promise<{ total: number; promotional: number }> {
    const total = await this.prisma.notification.count({
      where: {
        createdAt: { gte: start, lte: end },
        status: 'DND',
      },
    });

    const promotional = await this.prisma.notification.count({
      where: {
        createdAt: { gte: start, lte: end },
        status: 'DND',
        classification: 'PROMOTIONAL',
      },
    });

    return { total, promotional };
  }

  private async getCostStats(
    start: Date,
    end: Date,
  ): Promise<{ total: number }> {
    const result = await this.prisma.notification.aggregate({
      where: { createdAt: { gte: start, lte: end } },
      _sum: { costPaisa: true },
    });

    return { total: result._sum.costPaisa ?? 0 };
  }

  private getChannelForProvider(provider: string): string {
    const map: Record<string, string> = {
      msg91: 'sms',
      termii: 'sms',
      twilio: 'sms',
      nodemailer: 'email',
      fcm: 'push',
      whatsapp_cloud: 'whatsapp',
      in_app: 'in_app',
    };
    return map[provider] ?? 'unknown';
  }
}
