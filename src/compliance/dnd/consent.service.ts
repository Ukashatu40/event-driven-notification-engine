// src/compliance/dnd/consent.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface RecordConsentDto {
  userId: string;
  channel: string;
  consentType: 'OPT_IN' | 'OPT_OUT' | 'WHATSAPP_OPT_IN' | 'WHATSAPP_OPT_OUT';
  consentText: string;
  ipAddress: string;
  userAgent?: string;
  granted: boolean;
}

/**
 * Immutable consent audit trail.
 *
 * Consent records are NEVER deleted — they are the legal proof
 * that a user consented to receive communications.
 * Required for TRAI compliance audits (see Challenge B2.3).
 *
 * Separate opt-in required for:
 * - SMS promotional messages (TRAI)
 * - WhatsApp (WhatsApp Business Policy)
 * - Email marketing (IT Act 2000)
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(dto: RecordConsentDto): Promise<void> {
    await this.prisma.consentRecord.create({
      data: {
        userId: dto.userId,
        channel: dto.channel,
        consentType: dto.consentType,
        consentText: dto.consentText,
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent,
        granted: dto.granted,
      },
    });

    this.logger.log(
      `Consent recorded: user ${dto.userId} channel ${dto.channel} ` +
        `type ${dto.consentType} granted=${dto.granted}`,
    );
  }

  async hasConsent(
    userId: string,
    channel: string,
    consentType: string,
  ): Promise<boolean> {
    // Get the most recent consent record for this user+channel+type
    const latest = await this.prisma.consentRecord.findFirst({
      where: { userId, channel, consentType },
      orderBy: { grantedAt: 'desc' },
    });

    return latest?.granted ?? false;
  }

  async getConsentHistory(
    userId: string,
    channel?: string,
  ): Promise<
    Array<{
      channel: string;
      consentType: string;
      granted: boolean;
      grantedAt: Date;
    }>
  > {
    return this.prisma.consentRecord.findMany({
      where: {
        userId,
        ...(channel ? { channel } : {}),
      },
      select: {
        channel: true,
        consentType: true,
        granted: true,
        grantedAt: true,
      },
      orderBy: { grantedAt: 'desc' },
    });
  }
}
