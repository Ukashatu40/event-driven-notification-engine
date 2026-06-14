// src/analytics/analytics.controller.ts
import {
  Controller,
  Get,
  Query,
  //   ParseIntPipe,
  //   DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth('JWT')
@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('delivery-rates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get delivery rates by channel and priority',
    description:
      'Returns delivery metrics for the specified period. ' +
      'Includes per-channel rates, P99 latencies, cost summary, ' +
      'DND blocks, and frequency cap hits.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    description: 'Period in days (default: 7)',
    example: '7d',
  })
  @ApiResponse({ status: 200, description: 'Delivery rate report' })
  async getDeliveryRates(
    @Query('period') period: string = '7d',
  ): Promise<object> {
    const days = this.parsePeriod(period);
    return this.analyticsService.getDeliveryRates(days);
  }

  @Get('channel-performance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get per-channel and per-provider performance metrics',
  })
  @ApiQuery({ name: 'period', required: false, example: '7d' })
  @ApiResponse({ status: 200, description: 'Channel performance report' })
  async getChannelPerformance(
    @Query('period') period: string = '7d',
  ): Promise<object> {
    const days = this.parsePeriod(period);
    return this.analyticsService.getChannelPerformance(days);
  }

  @Get('opt-out-trends')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get opt-out and opt-in trends',
    description:
      'Rolling opt-out rate. Target: reduce from 23% to < 8% within 90 days.',
  })
  @ApiQuery({ name: 'period', required: false, example: '30d' })
  @ApiResponse({ status: 200, description: 'Opt-out trend data' })
  async getOptOutTrends(
    @Query('period') period: string = '30d',
  ): Promise<object> {
    const days = this.parsePeriod(period);
    return this.analyticsService.getOptOutTrends(days);
  }

  @Get('realtime')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get real-time notification counters',
    description:
      'Returns live counters with < 30 second lag. ' +
      'Sourced from Redis sliding window counters.',
  })
  @ApiResponse({ status: 200, description: 'Real-time stats' })
  async getRealtimeStats(): Promise<object> {
    return this.analyticsService.getRealtimeStats();
  }

  private parsePeriod(period: string): number {
    const match = /^(\d+)d?$/.exec(period);
    const days = match ? parseInt(match[1], 10) : 7;
    return Math.min(Math.max(days, 1), 90); // clamp between 1 and 90 days
  }
}
