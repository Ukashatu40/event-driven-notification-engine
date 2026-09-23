import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GlobalExceptionFilter } from './exceptions/global-exception.filter';
import { JwtAuthGuard } from '../api/guards/jwt-auth.guard';
import { RbacGuard } from '../api/guards/rbac.guard';
import { ResponseTransformInterceptor } from '../api/interceptors/response-transform.interceptor';
import { RequestCaseInterceptor } from '../api/interceptors/request-case.interceptor';
import { createValidationPipe } from './pipes/validation.pipe';
import { DataRetentionJob } from './jobs/data-retention.job';
import { PartitionMaintenanceJob } from './jobs/partition-maintenance.job';
import { PiiService } from './pii/pii.service';

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
      useValue: createValidationPipe(),
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
    // Accept snake_case request bodies (spec Appendix A) …
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestCaseInterceptor,
    },
    // … and emit snake_case, un-enveloped responses.
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseTransformInterceptor,
    },
    // 90-day data retention scrubbing (spec Section A10.2)
    DataRetentionJob,
    // Keeps next months' notifications partitions created ahead of time
    PartitionMaintenanceJob,
    // Column-level PII encryption + blind indexes (spec A10.2)
    PiiService,
  ],
  exports: [DataRetentionJob, PiiService],
})
export class SharedModule {}
