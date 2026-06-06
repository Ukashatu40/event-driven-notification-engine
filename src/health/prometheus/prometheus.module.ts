// src/health/prometheus/prometheus.module.ts
import { Global, Module } from '@nestjs/common';
import { PrometheusService } from './prometheus.service';

@Global()
@Module({
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}
