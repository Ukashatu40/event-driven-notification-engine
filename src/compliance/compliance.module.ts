// src/compliance/compliance.module.ts
import { Module } from '@nestjs/common';
import { DndService } from './dnd/dnd.service';
import { DndClassifierService } from './dnd/dnd-classifier.service';
import { ConsentService } from './dnd/consent.service';
import { FrequencyCapService } from './frequency-cap/frequency-cap.service';
import { QuietHoursService } from './quiet-hours/quiet-hours.service';
import { ConsentController } from './consent.controller';
import { ComplianceAuditController } from './audit/compliance-audit.controller';
import { ComplianceAuditService } from './audit/compliance-audit.service';

@Module({
  controllers: [ConsentController, ComplianceAuditController],
  providers: [
    ComplianceAuditService,
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
