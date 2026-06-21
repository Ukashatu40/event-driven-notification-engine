// src/notifications/notifications.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { StateService } from './state-machine/state.service';
import { PaginationDto, paginate } from '../shared/dto/pagination.dto';
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
      stateHistory: notification.stateLogs.map((log: any) => ({
        status: log.toStatus,
        fromStatus: log.fromStatus,
        timestamp: log.createdAt.toISOString(),
        actor: log.actor,
        metadata: log.metadata,
      })),
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

  async getDlqEntries(pagination: PaginationDto): Promise<object> {
    const [data, total] = await Promise.all([
      this.prisma.deadLetterQueue.findMany({
        where: { resolved: false },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
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
      this.prisma.deadLetterQueue.count({ where: { resolved: false } }),
    ]);

    return paginate(data, total, pagination);
  }

  async resolveDlqEntry(
    dlqId: string,
    action: 'retry' | 'discard',
    resolvedBy: string,
  ): Promise<object> {
    const entry = await this.prisma.deadLetterQueue.findUnique({
      where: { id: dlqId },
    });

    if (!entry) {
      throw new NotFoundException(`DLQ entry ${dlqId} not found`);
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

    // If retrying, reset notification status
    if (action === 'retry') {
      await this.stateService.transition(
        entry.notificationId,
        'RETRYING' as never,
        'dlq_manual_retry',
        { resolvedBy, action },
      );
    }

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
    consent_records_deleted: number;
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

    // Delete consent records
    const deletedConsent = await this.prisma.consentRecord.deleteMany({
      where: { userId },
    });

    // Anonymise the user record (replace PII with hashed/null values)
    const anonymisedPhone = `+910000000000`;
    const anonymisedEmail = `erased_${userId.substring(0, 8)}@anonymised.invalid`;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: '[ERASED]',
        phone: anonymisedPhone,
        email: anonymisedEmail,
      },
    });

    this.logger.log(
      `GDPR erasure completed for user ${userId}: ` +
        `${updateResult.count} notifications scrubbed, ` +
        `${deletedConsent.count} consent records deleted`,
    );

    return {
      notifications_scrubbed: updateResult.count,
      consent_records_deleted: deletedConsent.count,
      user_anonymised: true,
    };
  }
}
