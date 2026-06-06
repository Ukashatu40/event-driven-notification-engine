// src/main.ts

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false, // Pino handles logging — disable Fastify's built-in
      trustProxy: true, // needed for correct IP in rate limiting behind load balancer
    }),
    { bufferLogs: true },
  );

  // Replace NestJS default logger with Pino
  app.useLogger(app.get(Logger));

  // Global validation pipe — strict, no unknown fields allowed
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields silently
      forbidNonWhitelisted: true, // throw on unknown fields
      transform: true, // auto-transform to DTO types
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // URI versioning — all routes are /api/v1/...
  app.enableVersioning({ type: VersioningType.URI });
  app.setGlobalPrefix('api');

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
        '25+ event types, 5 delivery channels, TRAI DND compliance',
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
    .build();

  SwaggerModule.setup(
    'api-docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
    {
      swaggerOptions: { persistAuthorization: true },
    },
  );

  // Graceful shutdown — drain in-flight notifications before exiting
  app.enableShutdownHooks();

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(`Application running on port ${port}`, 'Bootstrap');
  logger.log(
    `Swagger docs available at http://localhost:${port}/api-docs`,
    'Bootstrap',
  );
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
