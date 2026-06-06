// src/templates/templates.module.ts
import { Module } from '@nestjs/common';
import { TemplateEngineService } from './engine/template-engine.service';
import { PersonalisationService } from './engine/personalisation.service';
import { SmsTruncationService } from './engine/sms-truncation.service';

@Module({
  providers: [
    TemplateEngineService,
    PersonalisationService,
    SmsTruncationService,
  ],
  exports: [
    TemplateEngineService,
    PersonalisationService,
    SmsTruncationService,
  ],
})
export class TemplatesModule {}
