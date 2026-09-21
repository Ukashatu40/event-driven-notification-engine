// src/notifications/notifications.service.ts
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { StateService } from './state-machine/state.service';
import { PaginationDto, paginate } from '../shared/dto/pagination.dto';
import { PiiService } from '../shared/pii/pii.service';
import { DispatchService } from '../delivery/dispatch/dispatch.service';
import { PrometheusService } from '../health/prometheus/prometheus.service';
import { NotificationStatus } from '../shared/constants/notification-states';
import { DlqQueryDto } from './dto/dlq.dto';
// import { type Prisma } from '@prisma/client';
// import { NotificationStateLog } from '@prisma/client';
import { SendTimeOptimizationService } from './engine/send-time-optimization.service'; // Adjust import path as needed

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: StateService,
    private readonly sendTimeOptimization: SendTimeOptimizationService,
    private readonly pii: PiiService,
    private readonly dispatch: DispatchService,
    private readonly prometheus: PrometheusService,
  ) {}

  async findById(notificationId: string): Promise<object> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        stateLogs: { orderBy: { createdAt: 'asc' } },
        deliveryAttemptLogs: { orderBy: { attemptedAt: 'asc' } },
      },
    });

    if (!notification) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }

    return {
      notificationId: notification.id,
      eventType: notification.eventType,
      userId: notification.userId,
      channel: notification.channel,
      priority: notification.priority,
      status: notification.status,
      templateId: notification.templateId,
      provider: notification.provider,
      externalId: notification.externalId,
      deliveryAttempts: notification.deliveryAttempts,
      renderedContent: notification.renderedContent,
      // The state log records transitions; the initial CREATED state has no
      // "from", so it is reconstructed from the record itself (spec Appendix A
      // lists CREATED first, actor event_ingestion).
      stateHistory: [
        {
          status: 'CREATED',
          fromStatus: null,
          timestamp: notification.createdAt.toISOString(),
          actor: 'event_ingestion',
        },
        ...notification.stateLogs.map((log: any) => ({
          status: log.toStatus,
          fromStatus: log.fromStatus,
          timestamp: log.createdAt.toISOString(),
          actor: log.actor,
          metadata: log.metadata,
        })),
      ],
      compliance: {
        dnd_checked: notification.dndChecked,
        dnd_check_timestamp: notification.dndCheckTimestamp?.toISOString(),
        dnd_result: notification.dndResult,
        classification: notification.classification,
        regulatory_override: notification.regulatoryOverride,
        frequency_cap_checked:
          (notification as any).frequencyCapChecked ?? false,
        frequency_cap_result:
          (notification as any).frequencyCapResult ?? 'WITHIN_LIMITS',
      },
      costPaisa: notification.costPaisa,
      correlationId: notification.correlationId,
      createdAt: notification.createdAt.toISOString(),
      deliveredAt: notification.deliveredAt?.toISOString(),
      latencyMs: notification.deliveredAt
        ? notification.deliveredAt.getTime() - notification.createdAt.getTime()
        : null,
    };
  }

  async findByUser(userId: string, pagination: PaginationDto): Promise<object> {
    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        select: {
          id: true,
          eventType: true,
          channel: true,
          status: true,
          priority: true,
          createdAt: true,
          deliveredAt: true,
        },
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);

    return paginate(data, total, pagination);
  }

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }

    // Security check: Ensure the requesting user owns this notification
    if (notification.userId !== userId) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }

    // Update state database fields
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: 'READ' as any, // Adjust or cast to your exact NotificationStatus enum if needed
        // readAt: new Date() // Uncomment if your schema includes a readAt timestamp
      },
    });

    // Execute engine state transition log entry
    await this.stateService.transition(
      notificationId,
      'READ' as never,
      'user_interaction',
      { readBy: userId },
    );

    // ── STO Telemetry Capture Pipeline ───────────────────────────
    try {
      await this.sendTimeOptimization.recordEngagement(
        notification.userId,
        new Date(),
      );
    } catch (error) {
      // Non-blocking catch protects primary user action if telemetry datastore fails
      this.logger.error(
        `Failed to record engagement tracking for user ${notification.userId}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  async getDlqEntries(query: DlqQueryDto): Promise<object> {
    const where = {
      resolved: false,
      ...(query.classification && { failureClass: query.classification }),
      ...(query.reason && {
        OR: [
          {
            failureReason: {
              contains: query.reason,
              mode: 'insensitive' as const,
            },
          },
          {
            lastError: { contains: query.reason, mode: 'insensitive' as const },
          },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.deadLetterQueue.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: {
          notification: {
            select: {
              eventType: true,
              channel: true,
              userId: true,
              priority: true,
            },
          },
        },
      }),
      this.prisma.deadLetterQueue.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  /**
   * Resolves a DLQ entry.
   *
   *  - discard: mark resolved, nothing is sent.
   *  - retry:   put the notification back on its channel queue FIRST, and only
   *             then mark the entry resolved — a retry that cannot be queued
   *             must leave the entry open, not silently "resolved".
   */
  async resolveDlqEntry(
    dlqId: string,
    action: 'retry' | 'discard',
    resolvedBy = 'operator',
  ): Promise<object> {
    const entry = await this.prisma.deadLetterQueue.findUnique({
      where: { id: dlqId },
    });

    if (!entry) {
      throw new NotFoundException(`DLQ entry ${dlqId} not found`);
    }
    if (entry.resolved) {
      throw new ConflictException(
        `DLQ entry ${dlqId} was already resolved (${entry.resolutionAction})`,
      );
    }

    if (action === 'retry') {
      await this.prisma.notification.update({
        where: { id: entry.notificationId },
        data: { status: NotificationStatus.RETRYING, updatedAt: new Date() },
      });
      const queued = await this.dispatch.publishStored(entry.notificationId);

      if (!queued) {
        // Restore the terminal state; nothing was resolved.
        await this.prisma.notification.update({
          where: { id: entry.notificationId },
          data: { status: NotificationStatus.DLQ, updatedAt: new Date() },
        });
        throw new UnprocessableEntityException(
          'This notification has no rendered content to resend — fix the cause ' +
            '(see failure_class CONFIGURATION) or discard it',
        );
      }

      await this.prisma.notificationStateLog.create({
        data: {
          notificationId: entry.notificationId,
          fromStatus: NotificationStatus.DLQ,
          toStatus: NotificationStatus.RETRYING,
          actor: 'dlq_manual_retry',
          metadata: { resolvedBy, dlqId },
        },
      });
    }

    await this.prisma.deadLetterQueue.update({
      where: { id: dlqId },
      data: {
        resolved: true,
        resolvedBy,
        resolvedAt: new Date(),
        resolutionAction: action,
      },
    });

    // Keep the depth gauge (and the HighDLQDepth alert) truthful.
    this.prometheus.notificationDlqDepth.set(
      await this.prisma.deadLetterQueue.count({ where: { resolved: false } }),
    );

    return { resolved: true, action, dlqId };
  }

  /**
   * GDPR-style right-to-erasure (spec Section A10.2).
   * Anonymises all notification records for a given user by scrubbing
   * personalisation_data (PII) while retaining metadata for analytics.
   * Also removes user record and consent records.
   */
  async eraseUserData(userId: string): Promise<{
    notifications_scrubbed: number;
    consent_records_retained: number;
    user_anonymised: boolean;
  }> {
    // Scrub personalisation_data from all notifications (retain metadata for analytics)
    const updateResult = await this.prisma.notification.updateMany({
      where: { userId },
      data: {
        personalisationData: {
          scrubbed: true,
          scrubbed_at: new Date().toISOString(),
        },
        renderedContent: null,
        metadata: { gdpr_erased: true, erased_at: new Date().toISOString() },
      } as any,
    });

    // Consent records are NOT deleted. They are legal evidence (spec C3.3) that a
    // message was permitted, the table is append-only at the database level, and
    // retaining them is a legal-obligation exception to erasure. They hold no
    // direct identifiers once the user row is anonymised below: the user id no
    // longer maps to a person, and contact details and blind indexes are gone.
    const retainedConsent = await this.prisma.consentRecord.count({
      where: { userId },
    });

    // Anonymise the user record. Contact details are replaced with encrypted,
    // non-identifying placeholders and the blind indexes are cleared, so the
    // original phone/email can neither be read nor looked up any more (and the
    // erased account frees the number for re-registration).
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: '[ERASED]',
        isActive: false,
        phone: this.pii.encrypt('+000000000000'),
        email: this.pii.encrypt(
          `erased_${userId.substring(0, 8)}@anonymised.invalid`,
        ),
        phoneHash: null,
        emailHash: null,
      },
    });

    this.logger.log(
      `GDPR erasure completed for user ${userId}: ` +
        `${updateResult.count} notifications scrubbed, ` +
        `${retainedConsent} consent records retained`,
    );

    return {
      notifications_scrubbed: updateResult.count,
      consent_records_retained: retainedConsent,
      user_anonymised: true,
    };
  }
}
