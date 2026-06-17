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
import { DashboardModule } from 'src/dashboard/dashboard.module';

@Module({
  imports: [
    ComplianceModule,
    PreferencesModule,
    TemplatesModule,
    DeliveryModule,
    DashboardModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationEngineService,
    DeduplicationService,
    StateService,
    RoutingEngineService,
    SendTimeOptimizationService,
  ],
  exports: [
    NotificationsService,
    NotificationEngineService,
    StateService,
    SendTimeOptimizationService,
  ],
})
export class NotificationsModule {}
