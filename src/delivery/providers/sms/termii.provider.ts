// src/delivery/providers/sms/termii.provider.ts
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
import { SmsTruncationService } from '../../../templates/engine/sms-truncation.service';

/**
 * Termii — Nigerian SMS provider (primary for the NG market).
 *
 * Routing (https://developers.termii.com/messaging-api):
 *   channel "dnd"     → delivers to ALL numbers regardless of NCC DND status,
 *                       and is not subject to the generic route's MTN 8PM–8AM
 *                       restriction. Reserved for TRANSACTIONAL messages.
 *   channel "generic" → promotional route; not delivered to DND-registered
 *                       numbers and time-restricted on MTN.
 *
 * The route is chosen from the message classification and NEVER the other way
 * round: a promotional message must not travel on the "dnd" route, so anything
 * not explicitly TRANSACTIONAL is sent as "generic".
 *
 * type "unicode" is used when the text is outside the GSM-7 alphabet (e.g.
 * Yoruba/Igbo/Hausa letters), otherwise "plain".
 *
 * Without TERMII_API_KEY the provider simulates success (dev/test), like the
 * MSG91 provider.
 */
@Injectable()
export class TermiiProvider implements IDeliveryProvider {
  readonly providerName = 'termii';
  readonly channel = 'sms';
  private readonly logger = new Logger(TermiiProvider.name);
  private readonly encoding = new SmsTruncationService();

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return (
      this.config.get<string>('TERMII_BASE_URL') ?? 'https://api.ng.termii.com'
    );
  }

  /** "dnd" only for transactional messages; everything else is "generic". */
  routeFor(notification: PreparedNotification): 'dnd' | 'generic' {
    return notification.classification === 'TRANSACTIONAL' ? 'dnd' : 'generic';
  }

  /** Termii wants international format without the leading "+". */
  static normalisePhone(phone: string): string {
    const digits = phone.replace(/[^\d]/g, '');
    return digits.startsWith('0') ? `234${digits.slice(1)}` : digits;
  }

  async send(notification: PreparedNotification): Promise<DeliveryResult> {
    const start = Date.now();
    const apiKey = this.config.get<string>('TERMII_API_KEY');
    const senderId =
      this.config.get<string>('TERMII_SENDER_ID') ?? 'WealthBrdg';

    if (!apiKey) {
      this.logger.debug(
        `[MOCK] Termii ${this.routeFor(notification)} SMS (${notification.body.length} chars)`,
      );
      return {
        success: true,
        externalId: `mock_termii_${Date.now()}`,
        receipt: 'simulated' as const,
        provider: this.providerName,
        latencyMs: Date.now() - start,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          to: TermiiProvider.normalisePhone(notification.recipient),
          from: senderId,
          sms: notification.body,
          type: this.encoding.isGsm7(notification.body) ? 'plain' : 'unicode',
          channel: this.routeFor(notification),
        }),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok || data['code'] !== 'ok') {
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
        externalId: String(data['message_id'] ?? ''),
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

  /** Nigerian mobile: (+234|0) then 7/8/9 + 0/1 + 8 digits, e.g. 0803…, +234 905… */
  async validateRecipient(phone: string): Promise<ValidationResult> {
    const valid = /^(?:\+?234|0)[789][01]\d{8}$/.test(
      phone.replace(/[\s-]/g, ''),
    );
    return {
      valid,
      reason: valid
        ? undefined
        : 'Must be a Nigerian mobile number, e.g. +2348031234567',
    };
  }

  async getQuota(): Promise<QuotaInfo> {
    const apiKey = this.config.get<string>('TERMII_API_KEY');
    if (!apiKey) {
      return {
        remaining: 999_999,
        resetAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
    }
    try {
      const res = await fetch(
        `${this.baseUrl}/api/get-balance?api_key=${encodeURIComponent(apiKey)}`,
      );
      const data = (await res.json()) as Record<string, unknown>;
      return {
        remaining: Number(data['balance'] ?? 0),
        resetAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
    } catch {
      return { remaining: 0, resetAt: new Date().toISOString() };
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.config.get<string>('TERMII_API_KEY')) return true;
    return (await this.getQuota()).remaining > 0;
  }
}
