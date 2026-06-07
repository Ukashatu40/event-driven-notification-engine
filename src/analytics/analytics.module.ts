// src/analytics/analytics.module.ts
import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { RealtimeCountersService } from './realtime-counters.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, RealtimeCountersService],
  exports: [AnalyticsService, RealtimeCountersService],
})
export class AnalyticsModule {}
