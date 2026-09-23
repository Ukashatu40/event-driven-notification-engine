// src/auth/otp-code-delivery.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { getMarketProfile } from '../shared/markets/market-profiles';
import { maskEmail, maskPhone } from '../shared/utils/pii-masker.util';
import { CircuitBreakerService } from '../delivery/circuit-breaker/circuit-breaker.service';
import { Msg91Provider } from '../delivery/providers/sms/msg91.provider';
import { TermiiProvider } from '../delivery/providers/sms/termii.provider';
import { TwilioProvider } from '../delivery/providers/sms/twilio.provider';
import { NodemailerProvider } from '../delivery/providers/email/nodemailer.provider';
import {
  type IDeliveryProvider,
  type PreparedNotification,
} from '../delivery/providers/delivery-provider.interface';

/**
 * "Deliver this 6-digit code to this phone/email" — the provider-selection
 * half of OTP, shared by login (`OtpService`) and sign-up (`SignupService`).
 * Nothing here is login- or signup-specific.
 *
 * Deliberately NOT the notification pipeline: sent synchronously, straight
 * through a provider, on the recipient's own request — see ADR-008. Nothing
 * here creates a Notification row.
 */
@Injectable()
export class OtpCodeDeliveryService {
  private readonly logger = new Logger(OtpCodeDeliveryService.name);
  private readonly smsProviders: Record<string, IDeliveryProvider>;

  constructor(
    private readonly config: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
    // Not stored as fields: only used here to build `smsProviders`.
    msg91: Msg91Provider,
    termii: TermiiProvider,
    twilio: TwilioProvider,
    private readonly email: NodemailerProvider,
  ) {
    this.smsProviders = { msg91, termii, twilio };
  }

  private otpBody(code: string, ttlSeconds: number): string {
    const appName = this.config.get<string>('app.name') ?? 'WealthBridge';
    const minutes = Math.round(ttlSeconds / 60);
    return `${code} is your ${appName} verification code. It expires in ${minutes} minutes. Do not share it.`;
  }

  /** Primary SMS provider for the market, falling back once on failure — mirrors DeliveryService's failover. */
  async sendSms(
    phone: string,
    market: string,
    code: string,
    ttlSeconds: number,
  ): Promise<void> {
    const [primaryName, fallbackName] = getMarketProfile(market).smsProviders;
    const notification: PreparedNotification = {
      notificationId: `otp-${uuidv4()}`,
      userId: 'otp',
      channel: 'sms',
      recipient: phone,
      body: this.otpBody(code, ttlSeconds),
      priority: 1,
      correlationId: `otp-${uuidv4()}`,
      classification: 'TRANSACTIONAL',
    };

    for (const name of [primaryName, fallbackName]) {
      const provider = this.smsProviders[name];
      if (!provider) continue;
      if (!(await this.circuitBreaker.allowRequest(provider.providerName))) {
        continue;
      }
      const result = await provider.send(notification);
      if (result.success) {
        await this.circuitBreaker.recordSuccess(provider.providerName);
        // .warn(), not .log(): OTP volume is low (never floods the log) and
        // this is the one place that would otherwise be completely invisible
        // in production (pino level is 'warn' there) if the SMS was accepted
        // by the provider but never actually arrived.
        this.logger.warn(
          `OTP SMS accepted by ${provider.providerName} for ${maskPhone(phone)} (externalId: ${result.externalId ?? 'n/a'})`,
        );
        return;
      }
      await this.circuitBreaker.recordFailure(provider.providerName);
      this.logger.warn(
        `OTP SMS send failed via ${provider.providerName} for ${maskPhone(phone)}: ${result.errorMessage}`,
      );
    }

    this.logSendFailure();
  }

  /** Only one email provider exists in this codebase — no failover chain to build. */
  async sendEmail(
    emailAddress: string,
    code: string,
    ttlSeconds: number,
  ): Promise<void> {
    const notification: PreparedNotification = {
      notificationId: `otp-${uuidv4()}`,
      userId: 'otp',
      channel: 'email',
      recipient: emailAddress,
      subject: `Your ${this.config.get<string>('app.name') ?? 'WealthBridge'} verification code`,
      body: this.otpBody(code, ttlSeconds),
      priority: 1,
      correlationId: `otp-${uuidv4()}`,
      classification: 'TRANSACTIONAL',
    };

    if (!(await this.circuitBreaker.allowRequest(this.email.providerName))) {
      this.logSendFailure();
      return;
    }
    const result = await this.email.send(notification);
    if (result.success) {
      await this.circuitBreaker.recordSuccess(this.email.providerName);
      // .warn(), not .log() — see the matching comment in sendSms(). A 250 OK
      // from the SMTP relay only means it was ACCEPTED, not that it reached
      // an inbox — provider-side holds (e.g. an unverified sending domain)
      // and spam filtering happen after this point and are invisible to us.
      this.logger.warn(
        `OTP email accepted by SMTP relay for ${maskEmail(emailAddress)} (messageId: ${result.externalId ?? 'n/a'})`,
      );
      return;
    }
    await this.circuitBreaker.recordFailure(this.email.providerName);
    this.logger.warn(
      `OTP email send failed for ${maskEmail(emailAddress)}: ${result.errorMessage}`,
    );
    this.logSendFailure();
  }

  /**
   * Both providers failed: the caller has already committed to its generic
   * response, so this is a warning, not a thrown error — surfacing delivery
   * failure to the caller would re-open the enumeration gap OTP is built to
   * avoid (see ADR-008).
   */
  private logSendFailure(): void {
    this.logger.error('OTP could not be delivered by any provider');
  }
}
