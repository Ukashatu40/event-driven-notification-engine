// src/delivery/providers/whatsapp/whatsapp-cloud.provider.ts
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
export class WhatsAppProvider implements IDeliveryProvider {
  readonly providerName = 'whatsapp_cloud';
  readonly channel = 'whatsapp';
  private readonly logger = new Logger(WhatsAppProvider.name);

  constructor(private readonly config: ConfigService) {}

  async send(notification: PreparedNotification): Promise<DeliveryResult> {
    const start = Date.now();
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_ID');
    const token = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');

    if (!phoneId || !token) {
      this.logger.debug(
        `[MOCK] WhatsApp to ${notification.recipient}: ${notification.body}`,
      );
      return {
        success: true,
        externalId: `mock_wa_${Date.now()}`,
        provider: this.providerName,
        latencyMs: Date.now() - start,
      };
    }

    try {
      const templateData = notification.data as
        | {
            templateName?: string;
            resolvedParameters?: string[];
          }
        | undefined;

      const payload = templateData?.templateName
        ? {
            messaging_product: 'whatsapp',
            to: notification.recipient,
            type: 'template',
            template: {
              name: templateData.templateName,
              language: { code: 'en_IN' },
              components: [
                {
                  type: 'body',
                  parameters: (templateData.resolvedParameters ?? []).map(
                    (text) => ({ type: 'text', text }),
                  ),
                },
              ],
            },
          }
        : {
            messaging_product: 'whatsapp',
            to: notification.recipient,
            type: 'text',
            text: { body: notification.body },
          };

      const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        return {
          success: false,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          errorCode: String(response.status),
          errorMessage: JSON.stringify(data['error'] ?? 'WhatsApp error'),
          rawResponse: data,
        };
      }

      const messages = data['messages'] as Array<{ id: string }> | undefined;

      return {
        success: true,
        externalId: messages?.[0]?.id ?? '',
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

  async getStatus(externalId: string): Promise<DeliveryStatus> {
    return {
      externalId,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    };
  }

  async validateRecipient(phone: string): Promise<ValidationResult> {
    const valid = /^\+[1-9]\d{6,14}$/.test(phone);
    return {
      valid,
      reason: valid ? undefined : 'Must be E.164 format',
    };
  }

  async getQuota(): Promise<QuotaInfo> {
    return {
      remaining: 1_000,
      resetAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
