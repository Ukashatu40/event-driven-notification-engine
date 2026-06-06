// src/delivery/providers/sms/msg91.provider.ts
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
export class Msg91Provider implements IDeliveryProvider {
  readonly providerName = 'msg91';
  readonly channel = 'sms';
  private readonly logger = new Logger(Msg91Provider.name);

  constructor(private readonly config: ConfigService) {}

  async send(notification: PreparedNotification): Promise<DeliveryResult> {
    const start = Date.now();
    const apiKey = this.config.get<string>('MSG91_API_KEY');
    const senderId = this.config.get<string>('MSG91_SENDER_ID') ?? 'WLTHBR';

    // In test/dev mode without API key, simulate success
    if (!apiKey) {
      this.logger.debug(
        `[MOCK] MSG91 SMS to ${notification.recipient}: ${notification.body}`,
      );
      return {
        success: true,
        externalId: `mock_msg91_${Date.now()}`,
        provider: this.providerName,
        latencyMs: Date.now() - start,
      };
    }

    try {
      const payload = {
        sender: senderId,
        route: '4', // transactional route
        country: '91',
        sms: [
          {
            message: notification.body,
            to: [notification.recipient.replace('+', '')],
          },
        ],
      };

      const response = await fetch('https://api.msg91.com/api/v2/sendsms', {
        method: 'POST',
        headers: {
          authkey: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok || data['type'] === 'error') {
        return {
          success: false,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          errorCode: String(data['code'] ?? response.status),
          errorMessage: String(data['message'] ?? 'Unknown error'),
          rawResponse: data,
        };
      }

      return {
        success: true,
        externalId: String(data['request_id'] ?? ''),
        provider: this.providerName,
        latencyMs: Date.now() - start,
        rawResponse: data,
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

  async getStatus(externalId: string): Promise<DeliveryStatus> {
    return {
      externalId,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    };
  }

  async validateRecipient(phone: string): Promise<ValidationResult> {
    const valid = /^(\+91|91)?[6-9]\d{9}$/.test(phone.replace(/\s/g, ''));
    return {
      valid,
      reason: valid ? undefined : 'Invalid Indian mobile number format',
    };
  }

  async getQuota(): Promise<QuotaInfo> {
    return {
      remaining: 10_000,
      resetAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
