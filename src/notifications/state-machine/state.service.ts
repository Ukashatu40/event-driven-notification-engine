// src/notifications/state-machine/state.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  NotificationStatus,
  isValidTransition,
} from '../../shared/constants/notification-states';
import { InvalidStateTransitionException } from '../../shared/exceptions/notification.exceptions';
import { Prisma } from '@prisma/client';

@Injectable()
export class StateService {
  private readonly logger = new Logger(StateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async transition(
    notificationId: string,
    to: NotificationStatus,
    actor: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { status: true },
    });

    if (!notification) {
      throw new Error(`Notification ${notificationId} not found`);
    }

    const from = notification.status as NotificationStatus;

    if (!isValidTransition(from, to)) {
      throw new InvalidStateTransitionException(from, to, notificationId);
    }

    await this.prisma.$transaction([
      this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: to, updatedAt: new Date() },
      }),
      this.prisma.notificationStateLog.create({
        data: {
          notificationId,
          fromStatus: from,
          toStatus: to,
          actor,
          metadata: (metadata ?? {}) as Prisma.InputJsonValue,
        },
      }),
    ]);

    this.logger.debug(
      `Notification ${notificationId}: ${from} → ${to} (actor: ${actor})`,
    );
  }

  async getHistory(notificationId: string): Promise<
    Array<{
      fromStatus: string | null;
      toStatus: string;
      actor: string;
      metadata: unknown;
      createdAt: Date;
    }>
  > {
    return this.prisma.notificationStateLog.findMany({
      where: { notificationId },
      orderBy: { createdAt: 'asc' },
      select: {
        fromStatus: true,
        toStatus: true,
        actor: true,
        metadata: true,
        createdAt: true,
      },
    });
  }
}
