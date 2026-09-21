// src/compliance/consent.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Roles } from '../api/decorators/roles.decorator';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { ALL_CHANNELS } from '../shared/constants/channels';
import { paginate } from '../shared/dto/pagination.dto';
import { ConsentService } from './dnd/consent.service';
import { ConsentHistoryQuery, RecordConsentBody } from './dto/consent.dto';

/**
 * Consent management API (spec A6.1: "explicit opt-in records with timestamps").
 * The log is append-only: to withdraw consent, POST an OPT_OUT — nothing is
 * ever edited or deleted.
 */
@ApiTags('compliance')
@ApiBearerAuth('JWT')
@Controller({ path: 'users/:userId/consents', version: '1' })
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles('SERVICE', 'ADMIN')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record a consent event (opt-in or opt-out)',
    description:
      'Append-only. `granted` is derived from `consent_type`. WhatsApp requires ' +
      "WHATSAPP_OPT_IN / WHATSAPP_OPT_OUT. Send the end user's `ip_address` and `user_agent`.",
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Consent event recorded' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 422, description: 'Invalid consent event' })
  async record(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: RecordConsentBody,
    @Req() req: FastifyRequest,
  ): Promise<object> {
    await this.assertUser(userId);

    const created = await this.consent.record({
      userId,
      channel: body.channel,
      consentType: body.consentType,
      consentText: body.consentText,
      ipAddress: body.ipAddress ?? req.ip,
      userAgent: body.userAgent ?? req.headers['user-agent'],
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

  @Roles('ADMIN', 'OPERATOR', 'SERVICE')
  @Get()
  @ApiOperation({ summary: 'Full consent history for a user (newest first)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async history(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: ConsentHistoryQuery,
  ): Promise<object> {
    await this.assertUser(userId);
    const { data, total } = await this.consent.getConsentHistory(
      userId,
      query.channel,
      query.skip,
      query.limit,
    );
    return paginate(data, total, query);
  }

  @Roles('ADMIN', 'OPERATOR', 'SERVICE')
  @Get('status')
  @ApiOperation({
    summary: 'Current consent per channel',
    description: 'The latest record per channel decides. `none` = never asked.',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async status(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<object> {
    await this.assertUser(userId);
    return {
      userId,
      channels: await this.consent.statusByChannel(userId, ALL_CHANNELS),
    };
  }

  private async assertUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
  }
}
