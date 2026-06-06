// src/delivery/providers/inapp/inapp.provider.ts
import { Injectable, Logger } from '@nestjs/common';
import {
  IDeliveryProvider,
  DeliveryResult,
  DeliveryStatus,
  ValidationResult,
  QuotaInfo,
  PreparedNotification,
} from '../delivery-provider.interface';

/**
 * In-app notification provider.
 * Stores notifications in DB and delivers via WebSocket if user is online.
 * Delivery rate is 100% for users who open the app — stored persistently.
 */
@Injectable()
export class InAppProvider implements IDeliveryProvider {
  readonly providerName = 'in_app';
  readonly channel = 'in_app';
  private readonly logger = new Logger(InAppProvider.name);

  // WebSocket gateway will be injected here in the WebSocket step
  // For now, we log and return success — DB persistence happens in NotificationService
  async send(notification: PreparedNotification): Promise<DeliveryResult> {
    const start = Date.now();

    this.logger.debug(
      `In-app notification stored for user ${notification.userId}: ${notification.title}`,
    );

    // In-app is always "delivered" to the store — read tracking happens separately
    return {
      success: true,
      externalId: `inapp_${notification.notificationId}`,
      provider: this.providerName,
      latencyMs: Date.now() - start,
    };
  }

  async getStatus(externalId: string): Promise<DeliveryStatus> {
    return {
      externalId,
      status: 'delivered', // stored = delivered for in-app
      updatedAt: new Date().toISOString(),
    };
  }

  async validateRecipient(_userId: string): Promise<ValidationResult> {
    return { valid: true };
  }

  async getQuota(): Promise<QuotaInfo> {
    return {
      remaining: 999_999,
      resetAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
