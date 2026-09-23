// src/preferences/preferences.controller.ts
import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { PreferencesService } from './preferences.service';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../api/decorators/roles.decorator';

@ApiTags('preferences')
@ApiBearerAuth('JWT')
@Controller({ path: 'users', version: '1' })
export class PreferencesController {
  constructor(private readonly preferencesService: PreferencesService) {}

  @Roles('ADMIN', 'OPERATOR', 'SERVICE')
  @Get(':userId/preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get user notification preferences',
    description:
      'Returns the full preference hierarchy including regulatory overrides ' +
      'that cannot be disabled by the user.',
  })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Preferences retrieved' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getPreferences(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<object> {
    return this.preferencesService.getPreferences(userId);
  }

  // spec Section A10.1: 10 requests/minute for preference updates
  @Roles('ADMIN', 'SERVICE')
  @Throttle({ standard: { limit: 10, ttl: 60_000 } })
  @Put(':userId/preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update user notification preferences',
    description:
      'Updates channel and digest preferences for a given event category. ' +
      'Returns warnings if regulatory-mandatory channels are disabled.',
  })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Preferences updated' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({
    status: 422,
    description: 'Validation failed',
  })
  async updatePreferences(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdatePreferenceDto,
  ): Promise<object> {
    return this.preferencesService.updatePreferences(userId, dto);
  }
}
