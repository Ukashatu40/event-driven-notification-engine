// src/compliance/audit/compliance-audit.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ValidationFailedException } from '../../shared/pipes/validation.pipe';

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 90;

/** States reached only after a provider was actually called. */
const SENT_STATES = ['SENT', 'DELIVERED', 'READ', 'BOUNCED'] as const;

/**
 * The TRAI/NCC audit reports (spec Challenge B2.3):
 *   1. every SMS in the window, with proof DND was checked before each send;
 *   2. consent records for every user who received a promotional message;
 *   plus delivery timestamps (latency) so SEBI timelines can be shown.
 *
 * Read-only views over data the pipeline already records at dispatch time —
 * nothing is inferred after the fact.
 */
@Injectable()
export class ComplianceAuditService {
  constructor(private readonly prisma: PrismaService) {}

  window(from?: string, to?: string): { from: Date; to: Date } {
    const end = to ? new Date(to) : new Date();
    const start = from
      ? new Date(from)
      : new Date(end.getTime() - MAX_WINDOW_DAYS * DAY_MS);

    if (start >= end) {
      throw new ValidationFailedException([
        { field: 'from', error: 'must be before `to`' },
      ]);
    }
    if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      throw new ValidationFailedException([
        {
          field: 'from',
          error: `window may not exceed ${MAX_WINDOW_DAYS} days`,
        },
      ]);
    }
    return { from: start, to: end };
  }

  /** Every SMS that reached (or was stopped before) a provider, with its DND proof. */
  async smsAudit(q: {
    from?: string;
    to?: string;
    skip: number;
    limit: number;
  }) {
    const { from, to } = this.window(q.from, q.to);
    const where = { channel: 'sms', createdAt: { gte: from, lt: to } };

    const [rows, total, unchecked] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.limit,
        select: {
          id: true,
          userId: true,
          eventType: true,
          classification: true,
          status: true,
          provider: true,
          createdAt: true,
          deliveredAt: true,
          dndChecked: true,
          dndCheckTimestamp: true,
          dndResult: true,
          regulatoryOverride: true,
          consentRecordId: true,
        },
      }),
      this.prisma.notification.count({ where }),
      // An SMS that left the system without a DND check is the finding an
      // auditor is looking for: it must be zero.
      this.prisma.notification.count({
        where: {
          ...where,
          status: { in: [...SENT_STATES] },
          dndChecked: false,
        },
      }),
    ]);

    return {
      period: { start: from.toISOString(), end: to.toISOString() },
      summary: { totalSms: total, sentWithoutDndCheck: unchecked },
      data: rows.map((r) => ({
        ...r,
        latencyMs: r.deliveredAt
          ? r.deliveredAt.getTime() - r.createdAt.getTime()
          : null,
      })),
      meta: { total, page: Math.floor(q.skip / q.limit) + 1, limit: q.limit },
    };
  }

  /** Every promotional message sent, with the consent record that authorised it. */
  async promotionalConsentAudit(q: {
    from?: string;
    to?: string;
    skip: number;
    limit: number;
  }) {
    const { from, to } = this.window(q.from, q.to);
    const where = {
      classification: 'PROMOTIONAL' as const,
      channel: { in: ['sms', 'email', 'whatsapp'] },
      status: { in: [...SENT_STATES] },
      createdAt: { gte: from, lt: to },
    };

    const [rows, total, withoutConsent] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.limit,
        select: {
          id: true,
          userId: true,
          eventType: true,
          channel: true,
          status: true,
          createdAt: true,
          consentRecordId: true,
        },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: { ...where, consentRecordId: null },
      }),
    ]);

    const ids = [
      ...new Set(
        rows.map((r) => r.consentRecordId).filter((x): x is string => !!x),
      ),
    ];
    const records = ids.length
      ? await this.prisma.consentRecord.findMany({ where: { id: { in: ids } } })
      : [];
    const byId = new Map(records.map((r) => [r.id, r]));

    return {
      period: { start: from.toISOString(), end: to.toISOString() },
      summary: {
        totalPromotional: total,
        withConsent: total - withoutConsent,
        withoutConsent,
      },
      data: rows.map((r) => {
        const c = r.consentRecordId ? byId.get(r.consentRecordId) : undefined;
        return {
          ...r,
          consentMissing: !c,
          consent: c && {
            recordId: c.id,
            consentType: c.consentType,
            granted: c.granted,
            consentText: c.consentText,
            ipAddress: c.ipAddress,
            recordedAt: c.grantedAt,
          },
        };
      }),
      meta: { total, page: Math.floor(q.skip / q.limit) + 1, limit: q.limit },
    };
  }
}
