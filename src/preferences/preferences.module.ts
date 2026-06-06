// src/preferences/preferences.module.ts
import { Module } from '@nestjs/common';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { PreferenceResolverService } from './preference-resolver.service';
import { PreferenceCacheService } from './preference-cache.service';

@Module({
  controllers: [PreferencesController],
  providers: [
    PreferencesService,
    PreferenceResolverService,
    PreferenceCacheService,
  ],
  exports: [PreferencesService, PreferenceResolverService],
})
export class PreferencesModule {}
