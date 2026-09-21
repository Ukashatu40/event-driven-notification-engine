// src/payments/payments.module.ts
import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { FlutterwaveAdapter } from './adapters/flutterwave.adapter';
import { InterswitchAdapter } from './adapters/interswitch.adapter';
import { OpayAdapter } from './adapters/opay.adapter';
import { PaystackAdapter } from './adapters/paystack.adapter';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [EventsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaystackAdapter,
    FlutterwaveAdapter,
    OpayAdapter,
    InterswitchAdapter,
  ],
})
export class PaymentsModule {}
