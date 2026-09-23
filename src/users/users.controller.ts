// src/users/users.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../api/decorators/roles.decorator';
import { ListUsersDto } from './dto/list-users.dto';
import { PaginatedResponse } from '../shared/dto/pagination.dto';
import { UserSummary, UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth('JWT')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles('ADMIN', 'OPERATOR', 'SERVICE')
  @Get()
  @ApiOperation({
    summary: 'Search or list users',
    description:
      'Matches `search` against the user name (case-insensitive, partial) ' +
      'or an exact user ID. Returns no contact details — only what is needed ' +
      'to pick a user (id, name, market, language, account type).',
  })
  @ApiResponse({ status: 200, description: 'Users matching the query' })
  async list(
    @Query() query: ListUsersDto,
  ): Promise<PaginatedResponse<UserSummary>> {
    return this.usersService.list(query);
  }
}
