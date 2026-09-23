// src/compliance/dto/consent.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsIP,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ALL_CHANNELS } from '../../shared/constants/channels';
import { PaginationDto } from '../../shared/dto/pagination.dto';

export const CONSENT_TYPES = [
  'OPT_IN',
  'OPT_OUT',
  'WHATSAPP_OPT_IN',
  'WHATSAPP_OPT_OUT',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export class RecordConsentBody {
  @ApiProperty({ enum: ALL_CHANNELS, example: 'whatsapp' })
  @IsIn(ALL_CHANNELS)
  channel!: string;

  @ApiProperty({
    enum: CONSENT_TYPES,
    description:
      'WhatsApp needs its own opt-in (WHATSAPP_OPT_IN / WHATSAPP_OPT_OUT) under the ' +
      'WhatsApp Business Policy; every other channel uses OPT_IN / OPT_OUT.',
  })
  @IsIn(CONSENT_TYPES)
  consentType!: ConsentType;

  @ApiProperty({
    description:
      'The exact wording shown to the user when they consented. Stored verbatim as evidence.',
    example:
      'I agree to receive investment updates from WealthBridge on WhatsApp.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  consentText!: string;

  @ApiPropertyOptional({
    description:
      "The END USER's IP address (callers are usually a backend service, so it cannot be inferred). " +
      'Falls back to the request IP.',
    example: '197.210.10.4',
  })
  @IsOptional()
  @IsIP()
  ipAddress?: string;

  @ApiPropertyOptional({
    description: "The end user's browser / app user agent",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;
}

export class ConsentHistoryQuery extends PaginationDto {
  @ApiPropertyOptional({ enum: ALL_CHANNELS })
  @IsOptional()
  @IsIn(ALL_CHANNELS)
  channel?: string;
}
