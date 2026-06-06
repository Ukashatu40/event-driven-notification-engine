// src/compliance/compliance.module.ts
import { Module } from '@nestjs/common';
import { DndService } from './dnd/dnd.service';
import { DndClassifierService } from './dnd/dnd-classifier.service';
import { ConsentService } from './dnd/consent.service';
import { FrequencyCapService } from './frequency-cap/frequency-cap.service';
import { QuietHoursService } from './quiet-hours/quiet-hours.service';

@Module({
  providers: [
    DndService,
    DndClassifierService,
    ConsentService,
    FrequencyCapService,
    QuietHoursService,
  ],
  exports: [
    DndService,
    DndClassifierService,
    ConsentService,
    FrequencyCapService,
    QuietHoursService,
  ],
})
export class ComplianceModule {}
