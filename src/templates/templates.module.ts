// src/templates/templates.module.ts
import { Module } from '@nestjs/common';
import { TemplateEngineService } from './engine/template-engine.service';
import { PersonalisationService } from './engine/personalisation.service';
import { SmsTruncationService } from './engine/sms-truncation.service';
import { AbTestingService } from './engine/ab-testing.service';
import { AbTestingController } from './engine/ab-testing.controller';

@Module({
  controllers: [AbTestingController],
  providers: [
    TemplateEngineService,
    PersonalisationService,
    SmsTruncationService,
    AbTestingService,
  ],
  exports: [TemplateEngineService, AbTestingService],
})
export class TemplatesModule {}
