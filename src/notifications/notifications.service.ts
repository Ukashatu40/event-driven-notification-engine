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
        dndChecked: notification.dndChecked,
        dndCheckTimestamp: notification.dndCheckTimestamp?.toISOString(),
        dndResult: notification.dndResult,
        classification: notification.classification,
        regulatoryOverride: notification.regulatoryOverride,
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
}
