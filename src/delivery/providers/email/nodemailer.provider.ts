// src/delivery/providers/email/nodemailer.provider.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import {
  IDeliveryProvider,
  DeliveryResult,
  DeliveryStatus,
  ValidationResult,
  QuotaInfo,
  PreparedNotification,
} from '../delivery-provider.interface';

@Injectable()
export class NodemailerProvider implements IDeliveryProvider, OnModuleInit {
  readonly providerName = 'nodemailer';
  readonly channel = 'email';
  private readonly logger = new Logger(NodemailerProvider.name);
  private transporter!: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    // Use Ethereal test account when no SMTP creds provided
    if (!user || !pass) {
      try {
        const testAccount = await nodemailer.createTestAccount();
        this.transporter = nodemailer.createTransport({
          host: 'smtp.ethereal.email',
          port: 587,
          secure: false,
          auth: {
            user: testAccount.user,
            pass: testAccount.pass,
          },
        });
        this.logger.log(
          `Email using Ethereal test account: ${testAccount.user}`,
        );
      } catch (err) {
        // Ethereal is a third-party test service; its outage must not take the
        // whole engine down. Fall back to an offline transport (nothing is
        // actually emailed) so every other channel keeps working.
        this.transporter = nodemailer.createTransport({ jsonTransport: true });
        this.logger.warn(
          `Could not create an Ethereal test account (${(err as Error).message}) — ` +
            'email is running on an offline JSON transport',
        );
      }
      return;
    }

    const port = this.config.get<number>('SMTP_PORT') ?? 587;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      // Was hardcoded false regardless of port — silently wrong (STARTTLS
      // handshake on a socket the server expects to be already-encrypted)
      // for port 465 specifically. Worth being correct now: if 587 keeps
      // seeing intermittent connection timeouts on a given host's egress
      // path, 465 (implicit TLS) is the standard fallback to try, and it
      // needs secure:true or the connection fails a different way.
      secure: port === 465,
      auth: { user, pass },
      // nodemailer's default is 2 minutes for each of these — against a
      // healthy relay (Brevo normally responds in 1-3s) that's needless
      // latency; against a genuinely stuck connection (observed live:
      // intermittent "Connection timeout" on a free-tier host's egress
      // path) it means every failed attempt burns 2 full minutes before
      // the retry backoff even starts, starving the retry budget down to
      // 2-3 real attempts instead of the dozen a fast-failing timeout
      // allows in the same wall-clock window.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }

  async send(notification: PreparedNotification): Promise<DeliveryResult> {
    const start = Date.now();

    try {
      const info = await this.transporter.sendMail({
        from: this.config.get<string>('SMTP_FROM') ?? 'noreply@wealthbridge.in',
        to: notification.recipient,
        subject: notification.subject ?? notification.title ?? 'Notification',
        text: notification.body,
      });

      this.logger.debug(
        `Email sent: ${nodemailer.getTestMessageUrl(info) || info.messageId}`,
      );

      return {
        success: true,
        externalId: info.messageId,
        provider: this.providerName,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        provider: this.providerName,
        latencyMs: Date.now() - start,
        errorCode: 'SMTP_ERROR',
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

  async validateRecipient(email: string): Promise<ValidationResult> {
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    return {
      valid,
      reason: valid ? undefined : 'Invalid email address format',
    };
  }

  async getQuota(): Promise<QuotaInfo> {
    return {
      remaining: 100_000,
      resetAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}
