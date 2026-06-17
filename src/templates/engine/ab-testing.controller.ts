// src/templates/engine/ab-testing.controller.ts
import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AbTestingService } from './ab-testing.service';

@ApiTags('templates')
@ApiBearerAuth('JWT')
@Controller({ path: 'templates', version: '1' })
export class AbTestingController {
  constructor(private readonly abTesting: AbTestingService) {}

  @Get(':eventType/ab-performance')
  @ApiOperation({
    summary: 'Get A/B variant performance for an event type',
    description:
      'Returns exposure count, delivery rate, and read rate per template variant. ' +
      'Used to decide whether to promote a variant to control.',
  })
  @ApiParam({ name: 'eventType', example: 'SIPX-001' })
  async getPerformance(@Param('eventType') eventType: string): Promise<object> {
    return this.abTesting.getVariantPerformance(eventType);
  }
}
