// src/delivery/delivery.service.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PrometheusService } from '../health/prometheus/prometheus.service';
import { CircuitBreakerService } from './circuit-breaker/circuit-breaker.service';
import { RetryWorkerService } from './retry/retry-worker.service';
import { Msg91Provider } from './providers/sms/msg91.provider';
import { TwilioProvider } from './providers/sms/twilio.provider';
import { TermiiProvider } from './providers/sms/termii.provider';
import { getMarketProfile } from '../shared/markets/market-profiles';
import { NodemailerProvider } from './providers/email/nodemailer.provider';
import { FcmProvider } from './providers/push/fcm.provider';
import { WhatsAppProvider } from './providers/whatsapp/whatsapp-cloud.provider';
import { InAppProvider } from './providers/inapp/inapp.provider';
import {
  IDeliveryProvider,
  PreparedNotification,
  DeliveryResult,
} from './providers/delivery-provider.interface';
import { classifyFailure } from '../shared/utils/failure-classifier.util';
import { DndService } from '../compliance/dnd/dnd.service';
import { ConsentService } from '../compliance/dnd/consent.service';
import { ConfigService } from '@nestjs/config';
import { DispatchService } from './dispatch/dispatch.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { NotificationStatus } from '../shared/constants/notification-states';
import { Priority } from '../shared/constants/priorities';
import { CHANNEL_COST_PAISA } from '../shared/constants/channels';
import { type EventType } from '../shared/constants/event-types';
import { Prisma } from '@prisma/client';

/** States from which a redelivered message must be acknowledged and ignored. */
const ALREADY_HANDLED = new Set<string>([
  NotificationStatus.NO_CONSENT,
  NotificationStatus.DIGESTED,
  NotificationStatus.SENT,
  NotificationStatus.DELIVERED,
  NotificationStatus.READ,
  NotificationStatus.DND,
  NotificationStatus.DLQ,
  NotificationStatus.BOUNCED,
]);

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  // Provider registry — primary and fallback per channel
  private readonly providers: Record<
    string,
    { primary: IDeliveryProvider; fallback?: IDeliveryProvider }
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prometheus: PrometheusService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly retryWorker: RetryWorkerService,
    private readonly msg91: Msg91Provider,
    private readonly twilio: TwilioProvider,
    private readonly nodemailer: NodemailerProvider,
    private readonly fcm: FcmProvider,
    private readonly whatsapp: WhatsAppProvider,
    private readonly inApp: InAppProvider,
    private readonly dndService: DndService,
    private readonly dispatch: DispatchService,
    private readonly termii: TermiiProvider,
    private readonly consent: ConsentService,
    private readonly config: ConfigService,
    // Optional: the live dashboard is a feature flag, and delivery must never depend on it.
    @Optional() private readonly dashboard?: DashboardGateway,
  ) {
    this.providers = {
      sms: { primary: this.msg91, fallback: this.twilio },
      email: { primary: this.nodemailer },
      push: { primary: this.fcm },
      whatsapp: { primary: this.whatsapp },
      in_app: { primary: this.inApp },
    };
  }

  /**
   * Entry point for the channel-queue consumers.
   *
   * 1. Idempotency — a redelivered / duplicated message for a notification that
   *    was already sent is acknowledged and dropped (no double-send on failover
   *    or broker redelivery).
   * 2. DND — checked HERE, immediately before dispatch (ADR-004), and the
   *    outcome is persisted on the notification as the TRAI audit record.
   * 3. Provider delivery with failover, retry scheduling and DLQ.
   */
  async process(queued: PreparedNotification): Promise<void> {
    let notification = queued;
    const record = await this.prisma.notification.findUnique({
      where: { id: notification.notificationId },
      select: { status: true, eventType: true, classification: true },
    });

    if (!record) {
      this.logger.error(
        `Dropping message for unknown notification ${notification.notificationId}`,
      );
      return;
    }

    if (ALREADY_HANDLED.has(record.status)) {
      this.logger.warn(
        `Skipping ${notification.notificationId}: already ${record.status}`,
      );
      return;
    }

    // A retried notification re-enters the pipeline as QUEUED.
    if ((record.status as NotificationStatus) === NotificationStatus.RETRYING) {
      await this.recordTransition(
        notification.notificationId,
        NotificationStatus.RETRYING,
        NotificationStatus.QUEUED,
        'retry_worker',
      );
    }

    // The queue only carries a user reference; resolve the real address now,
    // in memory, for this one send.
    let market: string | undefined;
    notification = { ...notification, classification: record.classification };
    if (['sms', 'whatsapp', 'email'].includes(notification.channel)) {
      const contact = await this.dispatch.lookupContact(
        notification.userId,
        notification.channel,
      );
      market = contact.market;
      notification = { ...notification, recipient: contact.recipient };
    }

    // Consent (WhatsApp always; promotional SMS/email). Checked at dispatch, like
    // DND, so a withdrawal takes effect on the very next send.
    if (!(await this.passesConsent(notification, record.classification)))
      return;

    if (notification.channel === 'sms') {
      const dnd = await this.dndService.check(
        notification.userId,
        notification.recipient,
        record.eventType as EventType,
        'sms',
      );

      await this.prisma.notification.update({
        where: { id: notification.notificationId },
        data: {
          dndChecked: true,
          dndCheckTimestamp: new Date(dnd.checkedAt),
          dndResult: dnd.registryStatus,
          classification: dnd.classification,
          ...(dnd.regulatoryOverride && { regulatoryOverride: true }),
        },
      });

      // Tripwire: a PROMOTIONAL SMS to a DND-registered number must be blocked
      // by DndService. If one is ever allowed through, that is a compliance
      // bug — count it (the DNDViolationDetected alert pages on this), and
      // refuse to send rather than commit the violation.
      if (
        dnd.allowed &&
        dnd.classification === 'PROMOTIONAL' &&
        dnd.registryStatus === 'REGISTERED'
      ) {
        this.prometheus.dndViolationsDetected.inc({
          channel: 'sms',
          classification: dnd.classification,
        });
        this.logger.error(
          `DND VIOLATION PREVENTED: promotional SMS ${notification.notificationId} to a registered number was allowed by the policy check`,
        );
        dnd.allowed = false;
        dnd.reason = 'DND_POLICY_TRIPWIRE';
      }

      if (!dnd.allowed) {
        if (dnd.registryUnavailable) {
          // Fail closed, but do not lose the message: retry, then DLQ.
          await this.handleFailure(notification, {
            success: false,
            provider: 'dnd_service',
            latencyMs: 0,
            errorCode: 'DND_CHECK_UNAVAILABLE',
            errorMessage: 'DND registry unavailable — promotional SMS withheld',
          });
          return;
        }

        await this.prisma.notification.update({
          where: { id: notification.notificationId },
          data: { status: NotificationStatus.DND, updatedAt: new Date() },
        });
        await this.recordTransition(
          notification.notificationId,
          NotificationStatus.QUEUED,
          NotificationStatus.DND,
          'dnd_service',
          { reason: dnd.reason, checkedAt: dnd.checkedAt },
        );
        return;
      }
    }

    await this.deliver(notification, market);
  }

  /**
   * Returns true when the send may proceed. In `enforce` mode a send without
   * valid consent is stopped (state NO_CONSENT); in `audit` mode it proceeds but
   * is logged and counted, so existing users can be migrated without an outage;
   * `off` skips the check. The record that authorised the send is stored on the
   * notification, so the audit can prove consent per message.
   */
  private async passesConsent(
    notification: PreparedNotification,
    classification: 'TRANSACTIONAL' | 'PROMOTIONAL',
  ): Promise<boolean> {
    const mode = this.config.get<string>('CONSENT_ENFORCEMENT') ?? 'enforce';
    if (mode === 'off') return true;

    let decision;
    try {
      decision = await this.consent.evaluate(
        notification.userId,
        notification.channel,
        classification,
      );
    } catch (err) {
      // Cannot prove consent → do not send, but do not lose the message either.
      await this.handleFailure(notification, {
        success: false,
        provider: 'consent_service',
        latencyMs: 0,
        errorCode: 'CONSENT_CHECK_UNAVAILABLE',
        errorMessage: `Consent lookup failed: ${(err as Error).message}`,
      });
      return false;
    }

    if (!decision.required) return true;

    if (decision.consentRecordId) {
      await this.prisma.notification.update({
        where: { id: notification.notificationId },
        data: { consentRecordId: decision.consentRecordId },
      });
    }
    if (decision.allowed) return true;

    this.prometheus.consentBlocksTotal.inc({
      channel: notification.channel,
      classification,
      reason: decision.reason,
      mode,
    });

    if (mode === 'audit') {
      this.logger.warn(
        `CONSENT AUDIT: ${notification.notificationId} (${notification.channel}, ${classification}) ` +
          `has no valid consent (${decision.reason}) — sent because CONSENT_ENFORCEMENT=audit`,
      );
      return true;
    }

    await this.prisma.notification.update({
      where: { id: notification.notificationId },
      data: { status: NotificationStatus.NO_CONSENT, updatedAt: new Date() },
    });
    await this.recordTransition(
      notification.notificationId,
      NotificationStatus.QUEUED,
      NotificationStatus.NO_CONSENT,
      'consent_service',
      {
        reason: decision.reason,
        consentRecordId: decision.consentRecordId ?? null,
      },
    );
    return false;
  }

  /**
   * Dead-letters a notification that can never be delivered (e.g. its template
   * failed to render). Nothing is swallowed: the failure is persisted, visible
   * in the DLQ API, and reflected in the depth gauge.
   */
  async deadLetter(
    notificationId: string,
    originalEvent: object,
    failure: { message: string; code: string },
    retryCount = 0,
  ): Promise<void> {
    const current = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { status: true },
    });

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: NotificationStatus.DLQ,
        failedReason: failure.message,
        updatedAt: new Date(),
      },
    });
    await this.recordTransition(
      notificationId,
      (current?.status as NotificationStatus | undefined) ?? null,
      NotificationStatus.DLQ,
      'delivery_pipeline',
      { code: failure.code, reason: failure.message },
    );

    // upsert, not create: a rolling deploy briefly runs the old and new
    // instance's consumers side by side, and both can end up processing the
    // same already-exceeded-retries message — observed live as an unhandled
    // "Unique constraint failed on the fields: (notificationId)" crash that
    // then nacked the message into RabbitMQ's own DLX on top of the row
    // already written by whichever instance got there first. Deliberately
    // leaves resolved/resolvedBy/resolvedAt untouched on the update branch —
    // an operator's manual resolution must never be silently reopened by a
    // late-arriving duplicate failure.
    await this.prisma.deadLetterQueue.upsert({
      where: { notificationId },
      create: {
        notificationId,
        originalEvent: this.redactRecipient(originalEvent),
        failureReason: failure.message,
        retryCount,
        lastError: failure.code,
        failureClass: classifyFailure(failure.code, failure.message),
      },
      update: {
        originalEvent: this.redactRecipient(originalEvent),
        failureReason: failure.message,
        retryCount,
        lastError: failure.code,
        failureClass: classifyFailure(failure.code, failure.message),
      },
    });

    const dlqDepth = await this.prisma.deadLetterQueue.count({
      where: { resolved: false },
    });
    this.prometheus.notificationDlqDepth.set(dlqDepth);

    this.logger.error(
      `Notification ${notificationId} dead-lettered: ${failure.code} — ${failure.message}`,
    );
  }

  /**
   * Provider chain for a channel. SMS depends on the user's market: India uses
   * MSG91 → Twilio, Nigeria uses Termii → Twilio (see MARKET_PROFILES).
   */
  private providersFor(
    channel: string,
    market?: string,
  ): { primary: IDeliveryProvider; fallback?: IDeliveryProvider } | undefined {
    if (channel === 'sms') {
      const [primary, fallback] = getMarketProfile(market).smsProviders;
      const byName: Record<string, IDeliveryProvider> = {
        msg91: this.msg91,
        termii: this.termii,
        twilio: this.twilio,
      };
      return { primary: byName[primary], fallback: byName[fallback] };
    }
    return this.providers[channel];
  }

  async deliver(
    notification: PreparedNotification,
    market?: string,
  ): Promise<void> {
    const channel = notification.channel;
    const providerConfig = this.providersFor(channel, market);

    if (!providerConfig) {
      this.logger.error(`No provider configured for channel: ${channel}`);
      return;
    }

    // Try primary provider first
    const result = await this.tryProvider(providerConfig.primary, notification);

    if (result.success) {
      await this.handleSuccess(notification, result);
      return;
    }

    // Primary failed — try fallback if available
    if (providerConfig.fallback) {
      this.logger.warn(
        `Primary provider ${providerConfig.primary.providerName} failed — ` +
          `trying fallback ${providerConfig.fallback.providerName}`,
      );

      const fallbackResult = await this.tryProvider(
        providerConfig.fallback,
        notification,
      );

      if (fallbackResult.success) {
        await this.handleSuccess(notification, fallbackResult);
        return;
      }
    }

    // Both failed — schedule retry or move to DLQ
    await this.handleFailure(notification, result);
  }

  // ── Private helpers ───────────────────────────────────────────────

  /** Never persist a phone/email address in the DLQ (spec A10.2). */
  private redactRecipient(event: object): object {
    return 'recipient' in event ? { ...event, recipient: '[redacted]' } : event;
  }

  private async recordTransition(
    notificationId: string,
    from: NotificationStatus | null,
    to: NotificationStatus,
    actor: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (to === NotificationStatus.QUEUED) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: to, updatedAt: new Date() },
      });
    }
    await this.prisma.notificationStateLog.create({
      data: {
        notificationId,
        fromStatus: from,
        toStatus: to,
        actor,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    await this.announce(notificationId, from, to);
  }

  /**
   * Tells the live dashboard about a transition. The engine's own transitions
   * are broadcast by NotificationStateService; delivery writes its states
   * directly, so it announces them here. Best effort: it never throws, and it
   * does no work when nobody is watching.
   */
  private async announce(
    notificationId: string,
    from: NotificationStatus | null,
    to: NotificationStatus,
  ): Promise<void> {
    if (!this.dashboard?.isWatched()) return;
    try {
      const n = await this.prisma.notification.findUnique({
        where: { id: notificationId },
        select: { userId: true, eventType: true, channel: true },
      });
      if (!n) return;
      this.dashboard.broadcastStateChange({
        notificationId,
        userId: n.userId,
        eventType: n.eventType,
        channel: n.channel,
        fromStatus: from,
        toStatus: to,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.debug(
        `Dashboard announce failed for ${notificationId}: ${(err as Error).message}`,
      );
    }
  }

  private async tryProvider(
    provider: IDeliveryProvider,
    notification: PreparedNotification,
  ): Promise<DeliveryResult> {
    // Check circuit breaker before calling provider
    const allowed = await this.circuitBreaker.allowRequest(
      provider.providerName,
    );

    if (!allowed) {
      this.logger.warn(
        `Circuit OPEN for ${provider.providerName} — failing fast`,
      );
      return {
        success: false,
        provider: provider.providerName,
        latencyMs: 0,
        errorCode: 'CIRCUIT_OPEN',
        errorMessage: `Circuit breaker is OPEN for ${provider.providerName}`,
      };
    }

    const result = await provider.send(notification);

    // Record result in circuit breaker
    if (result.success) {
      await this.circuitBreaker.recordSuccess(provider.providerName);
    } else {
      await this.circuitBreaker.recordFailure(provider.providerName);
    }

    return result;
  }

  private async handleSuccess(
    notification: PreparedNotification,
    result: DeliveryResult,
  ): Promise<void> {
    const updated = await this.prisma.notification.update({
      where: { id: notification.notificationId },
      data: {
        status: NotificationStatus.SENT,
        provider: result.provider,
        externalId: result.externalId,
        deliveryAttempts: { increment: 1 },
        costPaisa:
          (CHANNEL_COST_PAISA as Record<string, number>)[
            notification.channel
          ] ?? null,
        updatedAt: new Date(),
      },
      select: { deliveryAttempts: true },
    });

    await this.prisma.notificationStateLog.create({
      data: {
        notificationId: notification.notificationId,
        fromStatus: NotificationStatus.QUEUED,
        toStatus: NotificationStatus.SENT,
        actor: `${result.provider}_delivery_worker`,
        metadata: {
          externalId: result.externalId,
          latencyMs: result.latencyMs,
        },
      },
    });
    await this.announce(
      notification.notificationId,
      NotificationStatus.QUEUED,
      NotificationStatus.SENT,
    );

    await this.prisma.deliveryAttempt.create({
      data: {
        notificationId: notification.notificationId,
        attemptNumber: updated.deliveryAttempts,
        provider: result.provider,
        status: 'sent',
        latencyMs: result.latencyMs,
        responsePayload: (result.rawResponse as object) ?? {},
      },
    });

    if (result.receipt) {
      await this.confirmDelivery(notification, result);
    }

    this.prometheus.recordDelivery(
      notification.channel,
      result.provider,
      'delivered',
      result.latencyMs,
      String(notification.priority),
    );

    this.logger.log(
      `Delivered: ${notification.notificationId} via ${result.provider} ` +
        `(${result.latencyMs}ms) externalId=${result.externalId}`,
    );
  }

  /**
   * Moves SENT → DELIVERED for sends that no provider callback will ever
   * confirm (in-app store, or a mock-mode provider). Simulated receipts are
   * labelled in the state log so they can never be mistaken for real ones.
   */
  private async confirmDelivery(
    notification: PreparedNotification,
    result: DeliveryResult,
  ): Promise<void> {
    const simulated = result.receipt === 'simulated';
    const deliveredAt = new Date();

    const row = await this.prisma.notification.update({
      where: { id: notification.notificationId },
      data: {
        status: NotificationStatus.DELIVERED,
        deliveredAt,
        updatedAt: deliveredAt,
      },
      select: { createdAt: true },
    });

    await this.recordTransition(
      notification.notificationId,
      NotificationStatus.SENT,
      NotificationStatus.DELIVERED,
      simulated ? `${result.provider}_mock_dlr` : `${result.provider}_store`,
      { simulated },
    );

    this.prometheus.recordDeliveryLatency(
      notification.channel,
      (deliveredAt.getTime() - row.createdAt.getTime()) / 1000,
    );
  }

  private async handleFailure(
    notification: PreparedNotification,
    result: DeliveryResult,
  ): Promise<void> {
    const current = await this.prisma.notification.findUnique({
      where: { id: notification.notificationId },
      select: { deliveryAttempts: true, priority: true },
    });

    const attempts = (current?.deliveryAttempts ?? 0) + 1;
    const priority = current?.priority ?? Priority.MEDIUM;

    await this.prisma.notification.update({
      where: { id: notification.notificationId },
      data: {
        status: NotificationStatus.FAILED,
        deliveryAttempts: attempts,
        failedReason: result.errorMessage,
        updatedAt: new Date(),
      },
    });

    await this.prisma.deliveryAttempt.create({
      data: {
        notificationId: notification.notificationId,
        attemptNumber: attempts,
        provider: result.provider,
        status: 'failed',
        latencyMs: result.latencyMs,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      },
    });

    await this.recordTransition(
      notification.notificationId,
      NotificationStatus.QUEUED,
      NotificationStatus.FAILED,
      `${result.provider}_delivery_worker`,
      { errorCode: result.errorCode, attempt: attempts },
    );

    // Schedule retry or move to DLQ
    const willRetry = await this.retryWorker.scheduleRetry(
      notification.notificationId,
      attempts,
      priority,
    );

    if (!willRetry) {
      await this.moveToDlq(notification, result, attempts);
    }

    this.prometheus.recordDelivery(
      notification.channel,
      result.provider,
      'failed',
      result.latencyMs,
      String(notification.priority),
    );
  }

  private async moveToDlq(
    notification: PreparedNotification,
    result: DeliveryResult,
    retryCount: number,
  ): Promise<void> {
    await this.deadLetter(
      notification.notificationId,
      notification,
      {
        message: result.errorMessage ?? 'Max retries exceeded',
        code: result.errorCode ?? 'MAX_RETRIES_EXCEEDED',
      },
      retryCount,
    );
  }
}
