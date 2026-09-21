// src/compliance/dnd/consent.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  FieldError,
  ValidationFailedException,
} from '../../shared/pipes/validation.pipe';
import type { MessageClassification } from './dnd-classifier.service';
import type { ConsentType } from '../dto/consent.dto';

export interface RecordConsentDto {
  userId: string;
  channel: string;
  consentType: ConsentType;
  consentText: string;
  ipAddress: string;
  userAgent?: string;
}

export interface ConsentRecordView {
  id: string;
  channel: string;
  consentType: string;
  granted: boolean;
  consentText: string;
  ipAddress: string;
  userAgent: string | null;
  grantedAt: Date;
}

export interface ConsentDecision {
  /** Does this send need consent at all? */
  required: boolean;
  /** May it proceed (always true when not required)? */
  allowed: boolean;
  reason: string;
  /** The record the decision rests on — stored on the notification as evidence. */
  consentRecordId?: string;
}

/**
 * Consent management (spec A6.1 / C3.3 / B2.3).
 *
 * The log is APPEND-ONLY: withdrawing consent is a new record with granted=false,
 * and the database refuses UPDATE/DELETE/TRUNCATE on the table (migration
 * 20260922000001). The most recent record for a (user, channel) decides.
 *
 * What needs consent (evaluated at dispatch, like DND — a withdrawal must take
 * effect on the very next send):
 *   - WhatsApp: every message. WhatsApp Business Policy requires a separate,
 *     explicit opt-in before business-initiated messages, transactional or not.
 *   - SMS and email: PROMOTIONAL messages. Transactional ones (order
 *     confirmations, margin calls, OTPs) are exempt, as they are from DND.
 *   - Push and in-app: governed by the app's own permission model, not this log.
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** WhatsApp consent types belong to the whatsapp channel and only to it. */
  static validateCombination(
    channel: string,
    consentType: string,
  ): FieldError[] {
    const isWhatsAppType = consentType.startsWith('WHATSAPP_');
    if (channel === 'whatsapp' && !isWhatsAppType) {
      return [
        {
          field: 'consent_type',
          error:
            'WhatsApp requires its own opt-in: use WHATSAPP_OPT_IN or WHATSAPP_OPT_OUT',
        },
      ];
    }
    if (channel !== 'whatsapp' && isWhatsAppType) {
      return [
        {
          field: 'consent_type',
          error: `${consentType} can only be recorded for the whatsapp channel`,
        },
      ];
    }
    return [];
  }

  static requiresConsent(
    channel: string,
    classification: MessageClassification,
  ): boolean {
    if (channel === 'whatsapp') return true;
    if (channel === 'sms' || channel === 'email') {
      return classification === 'PROMOTIONAL';
    }
    return false;
  }

  async record(dto: RecordConsentDto): Promise<ConsentRecordView> {
    const problems = ConsentService.validateCombination(
      dto.channel,
      dto.consentType,
    );
    if (problems.length) {
      throw new ValidationFailedException(problems, 'Invalid consent event');
    }

    const granted = dto.consentType.endsWith('OPT_IN');

    const created = await this.prisma.consentRecord.create({
      data: {
        userId: dto.userId,
        channel: dto.channel,
        consentType: dto.consentType,
        consentText: dto.consentText,
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent,
        granted,
      },
    });

    this.logger.log(
      `Consent recorded: user ${dto.userId} channel ${dto.channel} ` +
        `type ${dto.consentType} granted=${granted}`,
    );
    return created;
  }

  /** The record that currently decides for this user and channel, if any. */
  async latest(
    userId: string,
    channel: string,
  ): Promise<ConsentRecordView | null> {
    return this.prisma.consentRecord.findFirst({
      where: { userId, channel },
      orderBy: { grantedAt: 'desc' },
    });
  }

  async hasConsent(userId: string, channel: string): Promise<boolean> {
    return (await this.latest(userId, channel))?.granted ?? false;
  }

  /** Current consent per channel (every channel is listed, `none` when never asked). */
  async statusByChannel(
    userId: string,
    channels: readonly string[],
  ): Promise<
    Array<{
      channel: string;
      status: 'granted' | 'withdrawn' | 'none';
      consentType: string | null;
      consentRecordId: string | null;
      since: Date | null;
    }>
  > {
    const latest = await Promise.all(
      channels.map((c) => this.latest(userId, c)),
    );
    return channels.map((channel, i) => {
      const r = latest[i];
      return {
        channel,
        status: r ? (r.granted ? 'granted' : 'withdrawn') : 'none',
        consentType: r?.consentType ?? null,
        consentRecordId: r?.id ?? null,
        since: r?.grantedAt ?? null,
      };
    });
  }

  async getConsentHistory(
    userId: string,
    channel?: string,
    skip = 0,
    take = 50,
  ): Promise<{ data: ConsentRecordView[]; total: number }> {
    const where = { userId, ...(channel ? { channel } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.consentRecord.findMany({
        where,
        orderBy: { grantedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.consentRecord.count({ where }),
    ]);
    return { data, total };
  }

  /**
   * The dispatch-time decision. Pure policy plus one indexed lookup; the caller
   * decides what to do with a refusal (block / audit-only / off).
   */
  async evaluate(
    userId: string,
    channel: string,
    classification: MessageClassification,
  ): Promise<ConsentDecision> {
    if (!ConsentService.requiresConsent(channel, classification)) {
      return { required: false, allowed: true, reason: 'CONSENT_NOT_REQUIRED' };
    }

    const record = await this.latest(userId, channel);

    if (!record) {
      return { required: true, allowed: false, reason: 'NO_CONSENT_RECORD' };
    }
    if (!record.granted) {
      return {
        required: true,
        allowed: false,
        reason: 'CONSENT_WITHDRAWN',
        consentRecordId: record.id,
      };
    }
    return {
      required: true,
      allowed: true,
      reason: 'CONSENT_GRANTED',
      consentRecordId: record.id,
    };
  }
}
