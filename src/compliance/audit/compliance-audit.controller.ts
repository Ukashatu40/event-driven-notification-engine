// src/compliance/audit/compliance-audit.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../api/decorators/roles.decorator';
import { AuditWindowQuery } from './audit.dto';
import { ComplianceAuditService } from './compliance-audit.service';

@ApiTags('compliance')
@ApiBearerAuth('JWT')
@Roles('ADMIN', 'OPERATOR') // read-only by nature; SERVICE has no business here
@Controller({ path: 'compliance/audit', version: '1' })
export class ComplianceAuditController {
  constructor(private readonly audit: ComplianceAuditService) {}

  @Get('sms')
  @ApiOperation({
    summary: 'SMS audit trail with proof that DND was checked before each send',
    description:
      'Challenge B2.3. Window defaults to the last 90 days (maximum 90). ' +
      '`summary.sent_without_dnd_check` must be 0.',
  })
  sms(@Query() q: AuditWindowQuery): Promise<object> {
    return this.audit.smsAudit(q);
  }

  @Get('promotional-consent')
  @ApiOperation({
    summary: 'Consent record behind every promotional message sent',
    description:
      'Challenge B2.3. `consent_missing: true` rows are compliance findings.',
  })
  promotionalConsent(@Query() q: AuditWindowQuery): Promise<object> {
    return this.audit.promotionalConsentAudit(q);
  }
}
