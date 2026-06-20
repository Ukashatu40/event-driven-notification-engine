// src/delivery/webhooks/webhooks.module.ts
import { Module } from '@nestjs/common';
import { WebhookDlrController } from './webhook-dlr.controller';
import { NotificationsModule } from '../../notifications/notifications.module';
import { HealthModule } from '../../health/health.module';

/**
 * WebhooksModule is registered at the AppModule level (not inside DeliveryModule)
 * to avoid the circular dependency:
 *   NotificationsModule → DeliveryModule → NotificationsModule
 *
 * By registering at AppModule level, it imports NotificationsModule and HealthModule
 * after both are fully initialised.
 */
@Module({
  imports: [NotificationsModule, HealthModule],
  controllers: [WebhookDlrController],
})
export class WebhooksModule {}
