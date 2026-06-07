// src/notifications/dto/ingest-event.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsInt,
  IsUUID,
  IsISO8601,
  IsObject,
  IsOptional,
  // IsIn,
  Min,
  Max,
} from 'class-validator';

export class IngestEventDto {
  @ApiProperty({ example: 'RISK-001' })
  @IsString()
  eventType!: string;

  @ApiProperty({ example: 'EVT-2025-03-19-MC-847291' })
  @IsString()
  eventId!: string;

  @ApiProperty({ example: 'margin_engine' })
  @IsString()
  sourceSystem!: string;

  @ApiProperty({ example: '2025-03-19T10:15:23.456Z' })
  @IsISO8601()
  timestamp!: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  priority!: number;

  @ApiProperty({ example: 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    example: { shortfall_amount: 125000, deadline: '2025-03-19T11:30:00Z' },
  })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 'margin-call-usr_a1b2c3d4-2025-03-19T10:15',
  })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
