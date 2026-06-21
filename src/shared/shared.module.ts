import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GlobalExceptionFilter } from './exceptions/global-exception.filter';
import { JwtAuthGuard } from '../api/guards/jwt-auth.guard';
import { RbacGuard } from '../api/guards/rbac.guard';
import { ResponseTransformInterceptor } from '../api/interceptors/response-transform.interceptor';
import { DataRetentionJob } from './jobs/data-retention.job';

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
    // Rate limiting guard (spec Section A10.1 — sliding window per IP and per user)
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RbacGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseTransformInterceptor,
    },
    // 90-day data retention scrubbing (spec Section A10.2)
    DataRetentionJob,
  ],
  exports: [DataRetentionJob],
})
export class SharedModule {}
