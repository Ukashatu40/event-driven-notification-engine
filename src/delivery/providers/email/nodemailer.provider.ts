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
      this.logger.log(`Email using Ethereal test account: ${testAccount.user}`);
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: this.config.get<number>('SMTP_PORT') ?? 587,
      secure: false,
      auth: { user, pass },
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
