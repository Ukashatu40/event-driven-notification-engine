// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import {
  appConfig,
  databaseConfig,
  redisConfig,
  kafkaConfig,
  rabbitmqConfig,
  envValidationSchema,
} from './config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { KafkaModule } from './infrastructure/kafka/kafka.module';
import { RabbitMQModule } from './infrastructure/rabbitmq/rabbitmq.module';
import { SharedModule } from './shared/shared.module';
import { HealthModule } from './health/health.module';
import { ComplianceModule } from './compliance/compliance.module';
import { PreferencesModule } from './preferences/preferences.module';
import { TemplatesModule } from './templates/templates.module';
import { DeliveryModule } from './delivery/delivery.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { EventsModule } from './events/events.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AuthModule } from './auth/auth.module';
import { WebhooksModule } from './delivery/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        kafkaConfig,
        rabbitmqConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
      expandVariables: true,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        redact: {
          paths: [
            'req.headers.authorization',
            'req.body.password',
            '*.phoneNumber',
            '*.email',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
    DatabaseModule,
    RedisModule,
    // Rate limiting — spec Section A10.1:
    //   100 req/min standard, 1000/min webhooks, 10/min preference updates
    //   Sliding window (not fixed) to prevent burst attacks at boundaries
    ThrottlerModule.forRoot([
      {
        name: 'standard',
        ttl: 60_000, // 60 seconds
        limit: 100,
      },
    ]),
    KafkaModule,
    RabbitMQModule,
    SharedModule,
    HealthModule,
    ComplianceModule,
    PreferencesModule,
    TemplatesModule,
    DeliveryModule,
    NotificationsModule,
    AnalyticsModule,
    EventsModule,
    DashboardModule,
    AuthModule,
    WebhooksModule,
  ],
})
export class AppModule {}
