// src/events/events.module.ts
import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { IngestionConsumerService } from './ingestion-consumer.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PreferencesModule } from '../preferences/preferences.module';

@Module({
  imports: [NotificationsModule, PreferencesModule],
  controllers: [EventsController],
  providers: [EventsService, IngestionConsumerService],
  exports: [EventsService],
})
export class EventsModule {}
