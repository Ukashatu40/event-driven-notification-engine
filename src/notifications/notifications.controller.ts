// src/notifications/notifications.controller.ts
import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
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
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { PaginationDto } from '../shared/dto/pagination.dto';

@ApiTags('notifications')
@ApiBearerAuth('JWT')
@Controller({ version: '1' })
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

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
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
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

  @Patch('notifications/:notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiParam({ name: 'notificationId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Marked as read' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async markAsRead(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @Body() body: { userId: string },
  ): Promise<void> {
    return this.notificationsService.markAsRead(notificationId, body.userId);
  }

  /**
   * GDPR-style right-to-erasure (spec Section A10.2).
   * Anonymises all notification records for a given user:
   *   - scrubs personalisation_data (PII) from all notification rows
   *   - deletes consent records
   *   - anonymises the user record
   * Metadata is retained for analytics.
   */
  @Delete('users/:userId/data')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'GDPR right-to-erasure — anonymise all data for a user',
    description:
      'Scrubs personalisation_data from all notification records, deletes consent records, ' +
      'and anonymises the user row. Metadata (event_type, channel, status, timestamps) is ' +
      'retained for analytics as permitted by legitimate interest. Requires ADMIN role.',
  })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Erasure completed',
    schema: {
      example: {
        notifications_scrubbed: 1247,
        consent_records_deleted: 3,
        user_anonymised: true,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async eraseUserData(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<object> {
    return this.notificationsService.eraseUserData(userId);
  }
}
