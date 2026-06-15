// src/delivery/delivery.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PrometheusService } from '../health/prometheus/prometheus.service';
import { CircuitBreakerService } from './circuit-breaker/circuit-breaker.service';
import { RetryWorkerService } from './retry/retry-worker.service';
import { Msg91Provider } from './providers/sms/msg91.provider';
import { TwilioProvider } from './providers/sms/twilio.provider';
import { NodemailerProvider } from './providers/email/nodemailer.provider';
import { FcmProvider } from './providers/push/fcm.provider';
import { WhatsAppProvider } from './providers/whatsapp/whatsapp-cloud.provider';
import { InAppProvider } from './providers/inapp/inapp.provider';
import {
  IDeliveryProvider,
  PreparedNotification,
  DeliveryResult,
} from './providers/delivery-provider.interface';
import { NotificationStatus } from '../shared/constants/notification-states';
import { Priority } from '../shared/constants/priorities';
import { Prisma } from '@prisma/client';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  // Provider registry — primary and fallback per channel
  private readonly providers: Record<
    string,
    { primary: IDeliveryProvider; fallback?: IDeliveryProvider }
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prometheus: PrometheusService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly retryWorker: RetryWorkerService,
    private readonly msg91: Msg91Provider,
    private readonly twilio: TwilioProvider,
    private readonly nodemailer: NodemailerProvider,
    private readonly fcm: FcmProvider,
    private readonly whatsapp: WhatsAppProvider,
    private readonly inApp: InAppProvider,
  ) {
    this.providers = {
      sms: { primary: this.msg91, fallback: this.twilio },
      email: { primary: this.nodemailer },
      push: { primary: this.fcm },
      whatsapp: { primary: this.whatsapp },
      in_app: { primary: this.inApp },
    };
  }

  async deliver(notification: PreparedNotification): Promise<void> {
    const channel = notification.channel;
    const providerConfig = this.providers[channel];

    if (!providerConfig) {
      this.logger.error(`No provider configured for channel: ${channel}`);
      return;
    }

    // Try primary provider first
    const result = await this.tryProvider(providerConfig.primary, notification);

    if (result.success) {
      await this.handleSuccess(notification, result);
      return;
    }

    // Primary failed — try fallback if available
    if (providerConfig.fallback) {
      this.logger.warn(
        `Primary provider ${providerConfig.primary.providerName} failed — ` +
          `trying fallback ${providerConfig.fallback.providerName}`,
      );

      const fallbackResult = await this.tryProvider(
        providerConfig.fallback,
        notification,
      );

      if (fallbackResult.success) {
        await this.handleSuccess(notification, fallbackResult);
        return;
      }
    }

    // Both failed — schedule retry or move to DLQ
    await this.handleFailure(notification, result);
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async tryProvider(
    provider: IDeliveryProvider,
    notification: PreparedNotification,
  ): Promise<DeliveryResult> {
    // Check circuit breaker before calling provider
    const allowed = await this.circuitBreaker.allowRequest(
      provider.providerName,
    );

    if (!allowed) {
      this.logger.warn(
        `Circuit OPEN for ${provider.providerName} — failing fast`,
      );
      return {
        success: false,
        provider: provider.providerName,
        latencyMs: 0,
        errorCode: 'CIRCUIT_OPEN',
        errorMessage: `Circuit breaker is OPEN for ${provider.providerName}`,
      };
    }

    const result = await provider.send(notification);

    // Record result in circuit breaker
    if (result.success) {
      await this.circuitBreaker.recordSuccess(provider.providerName);
    } else {
      await this.circuitBreaker.recordFailure(provider.providerName);
    }

    return result;
  }

  private async handleSuccess(
    notification: PreparedNotification,
    result: DeliveryResult,
  ): Promise<void> {
    await this.prisma.notification.update({
      where: { id: notification.notificationId },
      data: {
        status: NotificationStatus.SENT,
        provider: result.provider,
        externalId: result.externalId,
        updatedAt: new Date(),
      },
    });

    await this.prisma.notificationStateLog.create({
      data: {
        notificationId: notification.notificationId,
        fromStatus: NotificationStatus.QUEUED,
        toStatus: NotificationStatus.SENT,
        actor: `${result.provider}_delivery_worker`,
        metadata: {
          externalId: result.externalId,
          latencyMs: result.latencyMs,
        },
      },
    });

    await this.prisma.deliveryAttempt.create({
      data: {
        notificationId: notification.notificationId,
        attemptNumber: 1,
        provider: result.provider,
        status: 'sent',
        latencyMs: result.latencyMs,
        responsePayload: (result.rawResponse as object) ?? {},
      },
    });

    this.prometheus.recordDelivery(
      notification.channel,
      result.provider,
      'delivered',
      result.latencyMs,
      String(notification.priority),
    );

    this.logger.log(
      `Delivered: ${notification.notificationId} via ${result.provider} ` +
        `(${result.latencyMs}ms) externalId=${result.externalId}`,
    );
  }

  private async handleFailure(
    notification: PreparedNotification,
    result: DeliveryResult,
  ): Promise<void> {
    const current = await this.prisma.notification.findUnique({
      where: { id: notification.notificationId },
      select: { deliveryAttempts: true, priority: true },
    });

    const attempts = (current?.deliveryAttempts ?? 0) + 1;
    const priority = current?.priority ?? Priority.MEDIUM;

    await this.prisma.notification.update({
      where: { id: notification.notificationId },
      data: {
        status: NotificationStatus.FAILED,
        deliveryAttempts: attempts,
        failedReason: result.errorMessage,
        updatedAt: new Date(),
      },
    });

    // Schedule retry or move to DLQ
    const willRetry = await this.retryWorker.scheduleRetry(
      notification.notificationId,
      attempts,
      priority,
    );

    if (!willRetry) {
      await this.moveToDlq(notification, result, attempts);
    }

    this.prometheus.recordDelivery(
      notification.channel,
      result.provider,
      'failed',
      result.latencyMs,
      String(notification.priority),
    );
  }

  private async moveToDlq(
    notification: PreparedNotification,
    result: DeliveryResult,
    retryCount: number,
  ): Promise<void> {
    await this.prisma.notification.update({
      where: { id: notification.notificationId },
      data: { status: NotificationStatus.DLQ, updatedAt: new Date() },
    });

    await this.prisma.deadLetterQueue.create({
      data: {
        notificationId: notification.notificationId,
        originalEvent: notification as unknown as Prisma.InputJsonValue,
        failureReason: result.errorMessage ?? 'Max retries exceeded',
        retryCount,
        lastError: result.errorCode,
      },
    });

    // Update DLQ depth gauge
    const dlqDepth = await this.prisma.deadLetterQueue.count({
      where: { resolved: false },
    });
    this.prometheus.notificationDlqDepth.set(dlqDepth);

    this.logger.error(
      `Notification ${notification.notificationId} moved to DLQ after ${retryCount} attempts`,
    );
  }
}
