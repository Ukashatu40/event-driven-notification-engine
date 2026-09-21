// src/payments/payments.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { Public } from '../api/decorators/public.decorator';
import { PaymentsService, PaymentWebhookResult } from './payments.service';

/**
 * Inbound payment webhooks. Public (providers cannot hold our JWT) — the
 * provider's signature is the authentication, and the service fails closed when
 * a secret is not configured. Rate limit per spec A10.1: 1000/min for webhooks.
 */
@ApiTags('webhooks')
@Controller('webhooks/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Throttle({ standard: { limit: 1000, ttl: 60_000 } })
  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive an inbound-payment webhook',
    description:
      'Verifies the provider signature, then raises a TXNX-005 (Funds Deposited) ' +
      'event. Providers: paystack, flutterwave, opay, interswitch.',
  })
  @ApiParam({
    name: 'provider',
    enum: ['paystack', 'flutterwave', 'opay', 'interswitch'],
  })
  @ApiResponse({ status: 200, description: 'Accepted or deliberately ignored' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async receive(
    @Param('provider') provider: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | undefined>,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ): Promise<PaymentWebhookResult> {
    // Signatures are over the exact bytes received; never re-serialise.
    if (!req.rawBody) {
      throw new BadRequestException('Raw request body unavailable');
    }
    return this.payments.handle(provider, req.rawBody, headers, body);
  }
}
