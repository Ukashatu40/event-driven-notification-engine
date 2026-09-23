// src/me/me.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Roles } from '../api/decorators/roles.decorator';
import { CurrentUserId } from '../api/decorators/current-user-id.decorator';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PiiService } from '../shared/pii/pii.service';
import { maskPhone, maskEmail } from '../shared/utils/pii-masker.util';
import { ALL_CHANNELS } from '../shared/constants/channels';
import { PaginationDto, paginate } from '../shared/dto/pagination.dto';
import { PreferencesService } from '../preferences/preferences.service';
import { UpdatePreferenceDto } from '../preferences/dto/update-preference.dto';
import { ConsentService } from '../compliance/dnd/consent.service';
import {
  ConsentHistoryQuery,
  RecordConsentBody,
} from '../compliance/dto/consent.dto';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * The end-user self-service surface (ADR-008). Every handler takes its userId
 * from the verified USER token via @CurrentUserId(), never from a route
 * parameter — there is nothing here for one user to point at another user's
 * data. Business logic is not duplicated: everything delegates to the same
 * services the ops `/users/:userId/...` routes already use.
 */
@ApiTags('me')
@ApiBearerAuth('JWT')
@Roles('USER')
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly preferences: PreferencesService,
    private readonly consent: ConsentService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My profile' })
  async me(@CurrentUserId() userId: string): Promise<object> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Account not found');
    return {
      id: user.id,
      name: user.name,
      market: user.market,
      language: user.language,
      phone: maskPhone(this.pii.decrypt(user.phone)),
      email: maskEmail(this.pii.decrypt(user.email)),
    };
  }

  @Get('preferences')
  @ApiOperation({ summary: 'My notification preferences' })
  async getPreferences(@CurrentUserId() userId: string): Promise<object> {
    return this.preferences.getPreferences(userId);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update my notification preferences' })
  async updatePreferences(
    @CurrentUserId() userId: string,
    @Body() dto: UpdatePreferenceDto,
  ): Promise<object> {
    return this.preferences.updatePreferences(userId, dto);
  }

  @Get('consents')
  @ApiOperation({ summary: 'My consent history (newest first)' })
  async consentHistory(
    @CurrentUserId() userId: string,
    @Query() query: ConsentHistoryQuery,
  ): Promise<object> {
    const { data, total } = await this.consent.getConsentHistory(
      userId,
      query.channel,
      query.skip,
      query.limit,
    );
    return paginate(data, total, query);
  }

  @Get('consents/status')
  @ApiOperation({ summary: 'My current consent, per channel' })
  async consentStatus(@CurrentUserId() userId: string): Promise<object> {
    return {
      userId,
      channels: await this.consent.statusByChannel(userId, ALL_CHANNELS),
    };
  }

  @Post('consents')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record my own consent (opt in or out)',
    description:
      'Append-only, same as the ops endpoint. IP address and user agent are always taken from this request, never from the body.',
  })
  async recordConsent(
    @CurrentUserId() userId: string,
    @Body() body: RecordConsentBody,
    @Req() req: FastifyRequest,
  ): Promise<object> {
    const created = await this.consent.record({
      userId,
      channel: body.channel,
      consentType: body.consentType,
      consentText: body.consentText,
      // Deliberately NOT body.ipAddress / body.userAgent — see the summary above.
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return {
      consentId: created.id,
      userId,
      channel: created.channel,
      consentType: created.consentType,
      granted: created.granted,
      recordedAt: created.grantedAt,
    };
  }

  @Get('notifications')
  @ApiOperation({ summary: 'My notifications (newest first)' })
  async notificationsForMe(
    @CurrentUserId() userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<object> {
    return this.notifications.findByUser(userId, pagination);
  }

  @Patch('notifications/:notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one of my notifications as read' })
  async markRead(
    @CurrentUserId() userId: string,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<void> {
    return this.notifications.markAsRead(notificationId, userId);
  }
}
