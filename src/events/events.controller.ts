// src/events/events.controller.ts
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { EventsService } from './events.service';
import { IngestEventDto } from '../notifications/dto/ingest-event.dto';
import { Roles } from '../api/decorators/roles.decorator';

@ApiTags('events')
@ApiBearerAuth('JWT')
@Controller({ path: 'events', version: '1' })
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Roles('SERVICE', 'ADMIN')
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ingest a financial event for notification processing',
    description:
      'Primary entry point for all event producers — trading engine, ' +
      'risk engine, market data feed, compliance system. ' +
      'Returns 202 Accepted immediately. Processing is fully asynchronous. ' +
      'Supply an idempotency key to prevent duplicate processing.',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    description: 'Optional correlation ID for distributed tracing',
    required: false,
  })
  @ApiResponse({
    status: 202,
    description: 'Event accepted for processing',
    schema: {
      example: {
        notification_id: 'ntf_98765432-abcd-1234-ef56-789012345678',
        event_id: 'EVT-2025-03-19-MC-847291',
        status: 'CREATED',
        channels_targeted: ['sms', 'push', 'in_app'],
        estimated_delivery_ms: 3000,
        created_at: '2025-03-19T10:15:23.512Z',
      },
    },
  })
  @ApiResponse({
    status: 409,
    description: 'Duplicate event — idempotency key already processed',
  })
  @ApiResponse({ status: 422, description: 'Validation failed' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async ingestEvent(
    @Body() dto: IngestEventDto,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<object> {
    return this.eventsService.ingest(dto, correlationId);
  }
}
