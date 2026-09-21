// src/delivery/webhooks/webhook-dlr.controller.ts
/**
 * Webhook DLR (Delivery Receipt) Controller
 *
 * Spec Section A10.2: "Ensure webhook callbacks from providers are verified
 * using signature validation before processing."
 *
 * Spec Appendix B Sequence Diagram (Provider Failover):
 * "DLR Webhook → MSG91/Twilio calls back with delivery receipt;
 *  state updated to DELIVERED"
 *
 * This is the missing piece that allows notifications to reach DELIVERED state
 * from real provider responses. Without this endpoint the DELIVERED state is
 * only reachable via the manual mark-as-read endpoint.
 */
import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../api/decorators/public.decorator';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { StateService } from '../../notifications/state-machine/state.service';
import { NotificationStatus } from '../../shared/constants/notification-states';
import { PrometheusService } from '../../health/prometheus/prometheus.service';

/** MSG91 DLR status codes → internal status mapping */
const MSG91_STATUS_MAP: Record<string, NotificationStatus> = {
  DELIVRD: NotificationStatus.DELIVERED,
  UNDELIV: NotificationStatus.FAILED,
  EXPIRED: NotificationStatus.FAILED,
  REJECTD: NotificationStatus.FAILED,
  UNKNOWN: NotificationStatus.FAILED,
};

/** Twilio delivery status → internal status mapping */
const TWILIO_STATUS_MAP: Record<string, NotificationStatus> = {
  delivered: NotificationStatus.DELIVERED,
  undelivered: NotificationStatus.FAILED,
  failed: NotificationStatus.FAILED,
  sent: NotificationStatus.SENT,
};

/** FCM delivery result → internal status mapping */
const FCM_RESULT_MAP: Record<string, NotificationStatus> = {
  success: NotificationStatus.DELIVERED,
  error: NotificationStatus.FAILED,
};

// spec Section A10.1: 1000 requests/minute for webhook callbacks (delivery receipts)
@ApiTags('webhooks')
@Throttle({ standard: { limit: 1000, ttl: 60_000 } })
@Controller('webhooks')
export class WebhookDlrController {
  private readonly logger = new Logger(WebhookDlrController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly stateService: StateService,
    private readonly prometheus: PrometheusService,
  ) {}

  /**
   * MSG91 Delivery Receipt Callback
   * MSG91 sends a GET or POST callback with delivery status.
   * Signature: X-MSG91-Signature header = HMAC-SHA256(payload, webhookSecret)
   */
  @Public()
  @Post('dlr/sms/msg91')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'MSG91 SMS delivery receipt callback',
    description:
      'Receives delivery status callbacks from MSG91. ' +
      'Validates HMAC-SHA256 signature before processing.',
  })
  @ApiResponse({ status: 200, description: 'DLR processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async msg91Dlr(
    @Body() body: Record<string, unknown>,
    @Headers('x-msg91-signature') signature: string,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<{ processed: boolean }> {
    this.validateHmac(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      signature,
      'app.webhooks.msg91Secret',
      'MSG91',
    );

    const externalId = body['msgid'] as string;
    const dlrStatus = (body['status'] as string)?.toUpperCase();
    const status = MSG91_STATUS_MAP[dlrStatus] ?? NotificationStatus.FAILED;

    await this.processDeliveryReceipt(externalId, status, 'dlr_webhook_msg91', {
      dlr_status: dlrStatus,
      provider: 'msg91',
      raw: body,
    });

    return { processed: true };
  }

  /**
   * Twilio SMS Status Callback
   * Twilio posts form-encoded body with MessageStatus field.
   * Signature: X-Twilio-Signature header = HMAC-SHA1(url + params, authToken)
   */
  @Public()
  @Post('dlr/sms/twilio')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Twilio SMS status callback',
    description:
      'Receives delivery status callbacks from Twilio. ' +
      'Validates Twilio HMAC-SHA1 signature before processing.',
  })
  @ApiResponse({ status: 200, description: 'DLR processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async twilioDlr(
    @Body() body: Record<string, unknown>,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<{ processed: boolean }> {
    this.validateHmacSha1(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      signature,
      'app.webhooks.twilioAuthToken',
      'Twilio',
    );

    const externalId = body['MessageSid'] as string;
    const twilioStatus = body['MessageStatus'] as string;
    const status = TWILIO_STATUS_MAP[twilioStatus] ?? NotificationStatus.FAILED;

    await this.processDeliveryReceipt(
      externalId,
      status,
      'dlr_webhook_twilio',
      {
        dlr_status: twilioStatus,
        provider: 'twilio',
        error_code: body['ErrorCode'],
        raw: body,
      },
    );

    return { processed: true };
  }

  /**
   * FCM Push Delivery Receipt
   * FCM does not natively send DLRs to a webhook; this endpoint handles
   * custom push receipt forwarding from the mobile SDK (read receipts).
   * Signature: X-FCM-Signature = HMAC-SHA256(payload, fcmWebhookSecret)
   */
  @Public()
  @Post('dlr/push/fcm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'FCM push delivery / read receipt callback',
    description:
      'Receives push delivery and read receipts forwarded from the mobile SDK. ' +
      'Validates HMAC-SHA256 signature.',
  })
  @ApiResponse({ status: 200, description: 'DLR processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async fcmDlr(
    @Body() body: Record<string, unknown>,
    @Headers('x-fcm-signature') signature: string,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<{ processed: boolean }> {
    this.validateHmac(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      signature,
      'app.webhooks.fcmSecret',
      'FCM',
    );

    const externalId = body['messageId'] as string;
    const result = body['result'] as string; // 'success' | 'error'
    const isRead = body['read'] as boolean;

    const status = isRead
      ? NotificationStatus.READ
      : (FCM_RESULT_MAP[result] ?? NotificationStatus.DELIVERED);

    await this.processDeliveryReceipt(externalId, status, 'dlr_webhook_fcm', {
      fcm_result: result,
      is_read: isRead,
      provider: 'fcm',
      raw: body,
    });

    return { processed: true };
  }

  /**
   * WhatsApp Cloud API Status Webhook
   * Meta sends JSON callbacks with status: sent | delivered | read | failed
   * Signature: X-Hub-Signature-256 = sha256=HMAC-SHA256(payload, appSecret)
   */
  @Public()
  @Post('dlr/whatsapp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'WhatsApp Cloud API status webhook',
    description:
      'Receives delivery status updates from Meta WhatsApp Cloud API. ' +
      'Validates X-Hub-Signature-256 header.',
  })
  @ApiResponse({ status: 200, description: 'DLR processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async whatsappDlr(
    @Body() body: Record<string, unknown>,
    @Headers('x-hub-signature-256') hubSignature: string,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<{ processed: boolean }> {
    // Meta format: "sha256=<hex>"
    const signature = hubSignature?.replace('sha256=', '') ?? '';
    this.validateHmac(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      signature,
      'app.webhooks.whatsappAppSecret',
      'WhatsApp',
    );

    // WhatsApp sends nested structure: entry[].changes[].value.statuses[]
    const entries = (body['entry'] as Array<Record<string, unknown>>) ?? [];
    for (const entry of entries) {
      const changes =
        (entry['changes'] as Array<Record<string, unknown>>) ?? [];
      for (const change of changes) {
        const value = change['value'] as Record<string, unknown>;
        const statuses =
          (value?.['statuses'] as Array<Record<string, unknown>>) ?? [];
        for (const statusObj of statuses) {
          const externalId = statusObj['id'] as string;
          const waStatus = statusObj['status'] as string; // sent|delivered|read|failed
          const internalStatus =
            waStatus === 'read'
              ? NotificationStatus.READ
              : waStatus === 'delivered'
                ? NotificationStatus.DELIVERED
                : waStatus === 'failed'
                  ? NotificationStatus.FAILED
                  : NotificationStatus.SENT;

          await this.processDeliveryReceipt(
            externalId,
            internalStatus,
            'dlr_webhook_whatsapp',
            { wa_status: waStatus, provider: 'whatsapp_cloud', raw: statusObj },
          );
        }
      }
    }

    return { processed: true };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Resolves the notification by external provider message ID,
   * then transitions its state machine to the new status.
   */
  private async processDeliveryReceipt(
    externalId: string,
    newStatus: NotificationStatus,
    actor: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!externalId) {
      this.logger.warn(`DLR received with no externalId — skipping`);
      return;
    }

    const notification = await this.prisma.notification.findFirst({
      where: { externalId },
      select: { id: true, status: true, channel: true, createdAt: true },
    });

    if (!notification) {
      this.logger.warn(
        `DLR: no notification found for externalId=${externalId}`,
      );
      return;
    }

    try {
      await this.stateService.transition(
        notification.id,
        newStatus,
        actor,
        metadata,
      );

      // Record delivery latency in Prometheus if transitioning to DELIVERED
      if (newStatus === NotificationStatus.DELIVERED) {
        const latencySeconds =
          (Date.now() - notification.createdAt.getTime()) / 1000;
        this.prometheus.recordDeliveryLatency(
          notification.channel,
          latencySeconds,
        );
      }

      this.logger.log(
        `DLR processed: notification=${notification.id} ` +
          `externalId=${externalId} status=${newStatus}`,
      );
    } catch (err) {
      // State may already be in a terminal state — log but don't throw
      // (provider may send duplicate callbacks)
      this.logger.warn(
        `DLR state transition failed for ${notification.id}: ${(err as Error).message}`,
      );
    }
  }

  /** HMAC-SHA256 validation (MSG91, FCM, WhatsApp) */
  private validateHmac(
    payload: Buffer,
    receivedSignature: string,
    configKey: string,
    providerName: string,
  ): void {
    const secret = this.config.get<string>(configKey) ?? '';
    if (!secret) {
      // Fail CLOSED: an unconfigured secret must reject, not wave requests
      // through — otherwise anyone could forge delivery receipts.
      this.logger.error(
        `${providerName} webhook secret is not configured — rejecting the request`,
      );
      throw new UnauthorizedException(
        `${providerName} webhook is not configured`,
      );
    }

    if (!receivedSignature) {
      throw new UnauthorizedException(
        `Missing ${providerName} signature header`,
      );
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    const sigBuffer = Buffer.from(receivedSignature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      this.logger.error(
        `${providerName} DLR signature mismatch — possible replay attack`,
      );
      throw new UnauthorizedException(`Invalid ${providerName} signature`);
    }
  }

  /** HMAC-SHA1 validation (Twilio uses SHA1) */
  private validateHmacSha1(
    payload: Buffer,
    receivedSignature: string,
    configKey: string,
    providerName: string,
  ): void {
    const secret = this.config.get<string>(configKey) ?? '';
    if (!secret) {
      this.logger.error(
        `${providerName} auth token is not configured — rejecting the request`,
      );
      throw new UnauthorizedException(
        `${providerName} webhook is not configured`,
      );
    }

    if (!receivedSignature) {
      throw new UnauthorizedException(
        `Missing ${providerName} signature header`,
      );
    }

    const expected = crypto
      .createHmac('sha1', secret)
      .update(payload)
      .digest('base64');

    const a = Buffer.from(receivedSignature);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException(`Invalid ${providerName} signature`);
    }
  }
}
