// src/compliance/audit/audit.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import { PaginationDto } from '../../shared/dto/pagination.dto';

export class AuditWindowQuery extends PaginationDto {
  @ApiPropertyOptional({
    description: 'ISO-8601; default: 90 days before `to`',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601; default: now' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
