// src/users/dto/list-users.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../shared/dto/pagination.dto';

export class ListUsersDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Matches a name (case-insensitive, partial) or an exact user ID',
    example: 'ngozi',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;
}
