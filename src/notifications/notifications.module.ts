// src/notifications/notifications.module.ts
import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationEngineService } from './engine/notification-engine.service';
import { DeduplicationService } from './engine/deduplication.service';
import { StateService } from './state-machine/state.service';
import { RoutingEngineService } from './routing/routing-engine.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { PreferencesModule } from '../preferences/preferences.module';
import { TemplatesModule } from '../templates/templates.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { SendTimeOptimizationService } from './engine/send-time-optimization.service';
import { ScheduledReleaseService } from './engine/scheduled-release.service';
import { DigestBucketService } from './digest/digest-bucket.service';
import { DigestFlushService } from './digest/digest-flush.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { NotificationPreviewController } from './preview/notification-preview.controller';
import { NotificationPreviewService } from './preview/notification-preview.service';

@Module({
  imports: [
    ComplianceModule,
    PreferencesModule,
    TemplatesModule,
    DeliveryModule,
    DashboardModule,
  ],
  controllers: [NotificationsController, NotificationPreviewController],
  providers: [
    NotificationsService,
    NotificationEngineService,
    DeduplicationService,
    StateService,
    RoutingEngineService,
    SendTimeOptimizationService,
    ScheduledReleaseService,
    DigestBucketService,
    DigestFlushService,
    NotificationPreviewService,
  ],
  exports: [
    NotificationsService,
    NotificationEngineService,
    DeduplicationService,
    StateService,
    SendTimeOptimizationService,
    DigestFlushService,
  ],
})
export class NotificationsModule {}
