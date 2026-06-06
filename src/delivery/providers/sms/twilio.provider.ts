// src/delivery/providers/sms/twilio.provider.ts
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
export class TwilioProvider implements IDeliveryProvider {
  readonly providerName = 'twilio';
  readonly channel = 'sms';
  private readonly logger = new Logger(TwilioProvider.name);

  constructor(private readonly config: ConfigService) {}

  async send(notification: PreparedNotification): Promise<DeliveryResult> {
    const start = Date.now();
    const accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    const fromNumber = this.config.get<string>('TWILIO_FROM_NUMBER');

    if (!accountSid || !authToken) {
      this.logger.debug(
        `[MOCK] Twilio SMS to ${notification.recipient}: ${notification.body}`,
      );
      return {
        success: true,
        externalId: `mock_twilio_${Date.now()}`,
        provider: this.providerName,
        latencyMs: Date.now() - start,
      };
    }

    try {
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString(
        'base64',
      );
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

      const body = new URLSearchParams({
        To: notification.recipient,
        From: fromNumber ?? '',
        Body: notification.body,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        return {
          success: false,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          errorCode: String(data['code'] ?? response.status),
          errorMessage: String(data['message'] ?? 'Twilio error'),
          rawResponse: data,
        };
      }

      return {
        success: true,
        externalId: String(data['sid'] ?? ''),
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
    const valid = /^\+[1-9]\d{6,14}$/.test(phone);
    return {
      valid,
      reason: valid ? undefined : 'Must be E.164 format e.g. +919876543210',
    };
  }

  async getQuota(): Promise<QuotaInfo> {
    return {
      remaining: 50_000,
      resetAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
