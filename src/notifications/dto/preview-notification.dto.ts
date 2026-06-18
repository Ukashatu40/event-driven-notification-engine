// src/notifications/dto/preview-notification.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class PreviewNotificationDto {
  @ApiProperty({ example: 'a3f1c2e0-...' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ example: 'RISK-001' })
  @IsString()
  eventType!: string;

  @ApiProperty({
    example: { symbol: 'RELIANCE', amount: 50000, marginShortfall: 12500 },
    description: 'Same payload shape as the real event ingestion endpoint',
  })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 'hi',
    description:
      "Override the user's stored language preference for this preview only",
  })
  @IsOptional()
  @IsString()
  localeOverride?: string;
}
