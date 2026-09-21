// src/app.setup.ts
import { VersioningType } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { createValidationPipe } from './shared/pipes/validation.pipe';

/**
 * Everything that turns a bare Nest application into THIS service: validation,
 * versioned `/api/v1` routes, CORS, Swagger and shutdown hooks.
 *
 * It lives in one function so `main.ts` and the end-to-end tests configure the
 * app identically — an e2e test against a differently-configured app proves
 * nothing about the real one.
 */
export function configureApp(app: NestFastifyApplication): void {
  // Global validation pipe — strict, no unknown fields, 422 VALIDATION_FAILED
  app.useGlobalPipes(createValidationPipe());

  // URI versioning — all routes are /api/v1/...
  app.enableVersioning({ type: VersioningType.URI });
  // Operational endpoints stay at the root: Prometheus scrapes /metrics
  // (monitoring/prometheus.yml), and container health checks / Kubernetes probes
  // hit /health, /ready and /live (Dockerfile, docker-compose.yml). Under the
  // `api` prefix they were 404s, so scraping and the container health check
  // were both failing.
  app.setGlobalPrefix('api', {
    exclude: ['health', 'ready', 'live', 'metrics'],
  });

  // CORS
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  });

  // Swagger — available at /api-docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('WealthBridge Notification Engine')
    .setDescription(
      'Event-driven notification system for financial services — ' +
        '25+ event types, 5 delivery channels, TRAI/NCC DND compliance',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'JWT',
    )
    .addTag('events', 'Financial event ingestion')
    .addTag('notifications', 'Notification lifecycle management')
    .addTag('preferences', 'User notification preferences')
    .addTag('analytics', 'Delivery metrics and reporting')
    .addTag('compliance', 'DND and regulatory audit')
    .addTag('health', 'System health and readiness')
    .addTag('webhooks', 'Provider delivery receipts and inbound payments')
    .build();

  SwaggerModule.setup(
    'api-docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
    { swaggerOptions: { persistAuthorization: true } },
  );

  // Graceful shutdown — close broker/DB connections and stop workers on SIGTERM
  app.enableShutdownHooks();
}
