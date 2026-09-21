// src/notifications/dto/dlq.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../shared/dto/pagination.dto';

export const DLQ_ACTIONS = ['retry', 'discard'] as const;
export const FAILURE_CLASSES = [
  'TRANSIENT',
  'PERMANENT',
  'CONFIGURATION',
] as const;

export class ResolveDlqDto {
  @ApiProperty({ enum: DLQ_ACTIONS })
  @IsIn(DLQ_ACTIONS)
  action!: (typeof DLQ_ACTIONS)[number];

  @ApiPropertyOptional({
    description: 'Operator identifier; defaults to "operator".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  resolvedBy?: string;
}

export class DlqQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: FAILURE_CLASSES })
  @IsOptional()
  @IsIn(FAILURE_CLASSES)
  classification?: (typeof FAILURE_CLASSES)[number];

  @ApiPropertyOptional({
    description: 'Case-insensitive match on the failure reason or error code',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reason?: string;
}
