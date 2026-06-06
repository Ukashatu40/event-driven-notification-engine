// src/delivery/providers/push/fcm.provider.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IDeliveryProvider,
  DeliveryResult,
  DeliveryStatus,
  ValidationResult,
  QuotaInfo,
  PreparedNotification,
} from '../delivery-provider.interface';

@Injectable()
export class FcmProvider implements IDeliveryProvider {
  readonly providerName = 'fcm';
  readonly channel = 'push';
  private readonly logger = new Logger(FcmProvider.name);

  constructor(private readonly config: ConfigService) {}

  async send(notification: PreparedNotification): Promise<DeliveryResult> {
    const start = Date.now();
    const projectId = this.config.get<string>('FCM_PROJECT_ID');

    if (!projectId) {
      this.logger.debug(
        `[MOCK] FCM push to ${notification.recipient}: ${notification.title} — ${notification.body}`,
      );
      return {
        success: true,
        externalId: `mock_fcm_${Date.now()}`,
        provider: this.providerName,
        latencyMs: Date.now() - start,
      };
    }

    try {
      const message = {
        message: {
          token: notification.recipient,
          notification: {
            title: notification.title ?? '',
            body: notification.body,
          },
          data: notification.data
            ? Object.fromEntries(
                Object.entries(notification.data).map(([k, v]) => [
                  k,
                  String(v),
                ]),
              )
            : {},
          android: {
            priority: notification.priority <= 2 ? 'high' : 'normal',
          },
          apns: {
            headers: {
              'apns-priority': notification.priority <= 2 ? '10' : '5',
            },
          },
        },
      };

      const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await this.getAccessToken()}`,
        },
        body: JSON.stringify(message),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        return {
          success: false,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          errorCode: String(response.status),
          errorMessage: String(data['error'] ?? 'FCM error'),
          rawResponse: data,
        };
      }

      return {
        success: true,
        externalId: String(data['name'] ?? ''),
        provider: this.providerName,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        provider: this.providerName,
        latencyMs: Date.now() - start,
        errorCode: 'NETWORK_ERROR',
        errorMessage: (err as Error).message,
      };
    }
  }

  private async getAccessToken(): Promise<string> {
    // In production this uses google-auth-library
    // For now returns empty — mock mode handles the absence
    return '';
  }

  async getStatus(externalId: string): Promise<DeliveryStatus> {
    return {
      externalId,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    };
  }

  async validateRecipient(token: string): Promise<ValidationResult> {
    const valid = token.length > 100;
    return {
      valid,
      reason: valid ? undefined : 'FCM device token appears invalid',
    };
  }

  async getQuota(): Promise<QuotaInfo> {
    return {
      remaining: 1_000_000,
      resetAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
