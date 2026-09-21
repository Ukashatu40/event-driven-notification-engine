// src/delivery/delivery.module.ts
import { Module } from '@nestjs/common';
import { CircuitBreakerService } from './circuit-breaker/circuit-breaker.service';
import { RetryWorkerService } from './retry/retry-worker.service';
import { Msg91Provider } from './providers/sms/msg91.provider';
import { TwilioProvider } from './providers/sms/twilio.provider';
import { TermiiProvider } from './providers/sms/termii.provider';
import { NodemailerProvider } from './providers/email/nodemailer.provider';
import { FcmProvider } from './providers/push/fcm.provider';
import { WhatsAppProvider } from './providers/whatsapp/whatsapp-cloud.provider';
import { InAppProvider } from './providers/inapp/inapp.provider';
import { DeliveryService } from './delivery.service';
import { DispatchService } from './dispatch/dispatch.service';
import { DeliveryWorkerService } from './workers/delivery-worker.service';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [ComplianceModule],
  providers: [
    CircuitBreakerService,
    RetryWorkerService,
    Msg91Provider,
    TwilioProvider,
    TermiiProvider,
    NodemailerProvider,
    FcmProvider,
    WhatsAppProvider,
    InAppProvider,
    DeliveryService,
    DispatchService,
    DeliveryWorkerService,
  ],
  exports: [
    DeliveryService,
    DispatchService,
    CircuitBreakerService,
    RetryWorkerService,
  ],
})
export class DeliveryModule {}
