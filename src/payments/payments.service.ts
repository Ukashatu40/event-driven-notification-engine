// src/payments/payments.service.ts
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PiiService } from '../shared/pii/pii.service';
import { EventsService } from '../events/events.service';
import { IngestEventDto } from '../notifications/dto/ingest-event.dto';
import { EVENT_TYPES } from '../shared/constants/event-types';
import { FlutterwaveAdapter } from './adapters/flutterwave.adapter';
import { InterswitchAdapter } from './adapters/interswitch.adapter';
import { OpayAdapter } from './adapters/opay.adapter';
import { PaystackAdapter } from './adapters/paystack.adapter';
import {
  NormalizedPayment,
  PaymentProviderName,
  PaymentWebhookAdapter,
} from './payment.types';

export type PaymentWebhookResult =
  | { status: 'accepted'; notification_id: string; event_id: string }
  | { status: 'ignored'; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns a verified inbound-payment webhook (Paystack, Flutterwave, OPay,
 * Interswitch) into a TXNX-005 "Funds Deposited" event on the normal ingestion
 * path — Kafka, preferences, DND, quiet hours, templates, delivery all apply.
 *
 * Providers retry aggressively, so the answer is 2xx for anything we have
 * deliberately decided not to act on (not a payment, unknown user, wrong
 * currency) and an error only for things worth retrying (Kafka down).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly adapters: Map<string, PaymentWebhookAdapter>;

  constructor(
    paystack: PaystackAdapter,
    flutterwave: FlutterwaveAdapter,
    opay: OpayAdapter,
    interswitch: InterswitchAdapter,
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly events: EventsService,
  ) {
    this.adapters = new Map<string, PaymentWebhookAdapter>(
      [paystack, flutterwave, opay, interswitch].map((a) => [a.provider, a]),
    );
  }

  async handle(
    provider: string,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    body: Record<string, unknown>,
  ): Promise<PaymentWebhookResult> {
    const adapter = this.adapters.get(provider);
    if (!adapter)
      throw new NotFoundException(`Unknown payment provider: ${provider}`);

    if (!adapter.verify(rawBody, headers)) {
      // Log without echoing anything attacker-controlled.
      this.logger.warn(
        `Rejected ${adapter.provider} webhook: signature check failed`,
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payment = adapter.parse(body);
    if (!payment)
      return { status: 'ignored', reason: 'not_a_successful_payment' };

    if (payment.currency !== 'NGN') {
      return { status: 'ignored', reason: 'unsupported_currency' };
    }

    const userId = await this.resolveUser(payment);
    if (!userId) {
      this.logger.warn(
        `${adapter.provider} payment ${payment.reference}: no matching user — ignored`,
      );
      return { status: 'ignored', reason: 'user_not_found' };
    }

    const dto: IngestEventDto = {
      eventType: EVENT_TYPES.TXNX_005,
      eventId: `PAY-${payment.provider}-${payment.reference}`.slice(0, 100),
      sourceSystem: payment.provider,
      timestamp: new Date().toISOString(),
      priority: 2, // HIGH — spec A2.2: funds deposited, < 60s
      userId,
      payload: {
        amount: payment.amount,
        source: adapter.displayName,
        currency: payment.currency,
        reference: payment.reference,
      },
      // Provider retries reuse the same id, so they collapse to one notification.
      idempotencyKey: `payment:${payment.provider}:${payment.providerEventId}`,
    };

    const result = await this.events.ingest(dto);
    return {
      status: 'accepted',
      notification_id: result.notification_id,
      event_id: result.event_id,
    };
  }

  /** Explicit user id from provider metadata first, then the email blind index. */
  private async resolveUser(
    payment: NormalizedPayment,
  ): Promise<string | null> {
    if (payment.userId && UUID.test(payment.userId)) {
      const user = await this.prisma.user.findUnique({
        where: { id: payment.userId },
        select: { id: true },
      });
      if (user) return user.id;
    }

    if (payment.email) {
      const user = await this.prisma.user.findUnique({
        where: { emailHash: this.pii.emailHash(payment.email) },
        select: { id: true },
      });
      if (user) return user.id;
    }
    return null;
  }

  supportedProviders(): PaymentProviderName[] {
    return [...this.adapters.keys()] as PaymentProviderName[];
  }
}
