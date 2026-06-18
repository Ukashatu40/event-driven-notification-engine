// src/notifications/preview/notification-preview.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  NotificationPreviewService,
  NotificationPreview,
} from './notification-preview.service';
import { PreviewNotificationDto } from '../dto/preview-notification.dto';

@ApiTags('notifications')
@ApiBearerAuth('JWT')
@Controller({ path: 'notifications', version: '1' })
export class NotificationPreviewController {
  constructor(private readonly previewService: NotificationPreviewService) {}

  @Post('preview')
  @ApiOperation({
    summary: 'Preview a notification without sending it',
    description:
      'Renders the notification exactly as the user would receive it across all ' +
      'enabled channels, including A/B variant and locale, without persisting or ' +
      'queuing anything. No side effects.',
  })
  async preview(
    @Body() dto: PreviewNotificationDto,
  ): Promise<NotificationPreview> {
    return this.previewService.preview(
      dto.userId,
      dto.eventType,
      dto.payload,
      dto.localeOverride,
    );
  }
}
