// src/health/health.controller.ts
import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { HealthService, SystemHealth } from './health.service';
import { PrometheusService } from './prometheus/prometheus.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly prometheusService: PrometheusService,
  ) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Full system health check',
    description:
      'Returns health status of all components: database, Redis, Kafka, RabbitMQ',
  })
  @ApiResponse({ status: 200, description: 'System is healthy' })
  @ApiResponse({ status: 503, description: 'One or more components are down' })
  async health(@Res() reply: FastifyReply): Promise<void> {
    const result: SystemHealth = await this.healthService.getHealth();

    const statusCode =
      result.status === 'healthy'
        ? HttpStatus.OK
        : result.status === 'degraded'
          ? HttpStatus.OK // degraded still serves traffic
          : HttpStatus.SERVICE_UNAVAILABLE;

    void reply.status(statusCode).send(result);
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Used by container orchestrators. Returns 200 when ready to serve traffic.',
  })
  @ApiResponse({ status: 200, description: 'Ready' })
  @ApiResponse({ status: 503, description: 'Not ready' })
  async ready(@Res() reply: FastifyReply): Promise<void> {
    const isReady = await this.healthService.isReady();

    void reply
      .status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .send({ ready: isReady, timestamp: new Date().toISOString() });
  }

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Used by container orchestrators. Returns 200 as long as process is alive.',
  })
  @ApiResponse({ status: 200, description: 'Alive' })
  alive(): { alive: boolean; timestamp: string } {
    return {
      alive: this.healthService.isAlive(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Prometheus metrics',
    description:
      'Exposes all application metrics in Prometheus text format. Scraped by Prometheus server.',
  })
  @ApiResponse({ status: 200, description: 'Prometheus metrics text' })
  async metrics(@Res() reply: FastifyReply): Promise<void> {
    const metrics = await this.prometheusService.getMetrics();
    void reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .status(HttpStatus.OK)
      .send(metrics);
  }
}
