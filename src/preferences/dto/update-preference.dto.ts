// src/preferences/dto/update-preference.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

export enum DigestMode {
  IMMEDIATE = 'IMMEDIATE',
  HOURLY = 'HOURLY',
  DAILY = 'DAILY',
}

export class ChannelPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  sms?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  in_app?: boolean;
}

export class UpdatePreferenceDto {
  @ApiProperty({
    example: 'TXNX',
    description: 'Event category code e.g. TXNX, RISK, SIPX, MKTX, REGX',
  })
  @IsString()
  category!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiProperty({ type: () => ChannelPreferencesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ChannelPreferencesDto)
  channels!: ChannelPreferencesDto;

  @ApiPropertyOptional({ enum: DigestMode })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(DigestMode)
  digestMode?: DigestMode;

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'quietHoursStart must be in HH:MM format',
  })
  quietHoursStart?: string;

  @ApiPropertyOptional({ example: '07:30' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'quietHoursEnd must be in HH:MM format',
  })
  quietHoursEnd?: string;
}
