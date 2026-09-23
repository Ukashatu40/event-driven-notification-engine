// src/me/me.module.ts
import { Module } from '@nestjs/common';
import { PreferencesModule } from '../preferences/preferences.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MeController } from './me.controller';

@Module({
  imports: [PreferencesModule, ComplianceModule, NotificationsModule],
  controllers: [MeController],
})
export class MeModule {}
