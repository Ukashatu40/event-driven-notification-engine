// src/notifications/notifications.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { StateService } from './state-machine/state.service';
import { PaginationDto, paginate } from '../shared/dto/pagination.dto';
// import { type Prisma } from '@prisma/client';
// import { NotificationStateLog } from '@prisma/client';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: StateService,
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
