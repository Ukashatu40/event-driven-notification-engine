// src/notifications/notifications.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationEngineService } from './engine/notification-engine.service';
import { IngestEventDto } from './dto/ingest-event.dto';
import { PaginationDto } from '../shared/dto/pagination.dto';
import { v4 as uuidv4 } from 'uuid';

@ApiTags('notifications')
@ApiBearerAuth('JWT')
@Controller({ version: '1' })
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly engineService: NotificationEngineService,
  ) {}

  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ingest a financial event for notification processing',
    description:
      'Primary entry point for all event producers. ' +
      'Returns 202 Accepted immediately — processing is asynchronous.',
  })
  @ApiResponse({ status: 202, description: 'Event accepted for processing' })
  @ApiResponse({ status: 409, description: 'Duplicate event (idempotency)' })
  @ApiResponse({ status: 422, description: 'Validation failed' })
  async ingestEvent(
    @Body() dto: IngestEventDto,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<object> {
    const cid = correlationId ?? uuidv4();
    const notificationId = await this.engineService.process(dto, cid);

    return {
      notificationId,
      eventId: dto.eventId,
      status: 'CREATED',
      estimatedDeliveryMs: this.estimateDeliveryMs(dto.priority),
      createdAt: new Date().toISOString(),
    };
  }

  @Get('notifications/:notificationId')
  @ApiOperation({ summary: 'Get notification status and full state history' })
  @ApiParam({ name: 'notificationId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Notification details' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getNotification(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<object> {
    return this.notificationsService.findById(notificationId);
  }

  @Get('users/:userId/notifications')
  @ApiOperation({ summary: 'Get paginated notifications for a user' })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  async getUserNotifications(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<object> {
    return this.notificationsService.findByUser(userId, pagination);
  }

  @Get('dlq')
  @ApiOperation({ summary: 'List unresolved dead letter queue entries' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getDlq(@Query() pagination: PaginationDto): Promise<object> {
    return this.notificationsService.getDlqEntries(pagination);
  }

  @Patch('dlq/:dlqId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a DLQ entry — retry or discard' })
  @ApiParam({ name: 'dlqId', type: String, format: 'uuid' })
  async resolveDlq(
    @Param('dlqId', ParseUUIDPipe) dlqId: string,
    @Body() body: { action: 'retry' | 'discard'; resolvedBy: string },
  ): Promise<object> {
    return this.notificationsService.resolveDlqEntry(
      dlqId,
      body.action,
      body.resolvedBy,
    );
  }

  private estimateDeliveryMs(priority: number): number {
    const estimates: Record<number, number> = {
      1: 3_000,
      2: 10_000,
      3: 60_000,
      5: 300_000,
    };
    return estimates[priority] ?? 30_000;
  }
}
