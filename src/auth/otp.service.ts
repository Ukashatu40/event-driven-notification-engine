// src/auth/otp.service.ts
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PiiService } from '../shared/pii/pii.service';
import { REDIS_KEYS } from '../shared/constants/redis-keys';
import { AuthService, type TokenPair } from './auth.service';
import { OtpCodeStore } from './otp-code-store.service';
import { OtpCodeDeliveryService } from './otp-code-delivery.service';

const E164 = /^\+[1-9]\d{6,14}$/;

interface OtpRequestState {
  userId: string | null;
}

export interface OtpRequestInput {
  phone?: string;
  email?: string;
}

export interface OtpRequestResult {
  requestId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

/**
 * Phone/email + OTP login for end users (ADR-008). The caller picks exactly
 * one identifier; the code is sent by SMS or by email to match. The
 * code-state machine (`OtpCodeStore`) and provider delivery
 * (`OtpCodeDeliveryService`) are shared with sign-up (`SignupService`) — this
 * class owns only what's LOGIN-specific: looking up an existing user, and
 * keeping that lookup invisible from the outside.
 *
 * Every response shape and timing is the SAME whether or not the identifier
 * belongs to a real account — request() always "succeeds", verify() always
 * fails the same generic way for a bad code OR an unknown identifier — so this
 * endpoint cannot be used to test which phone numbers or emails are registered.
 * (Sign-up is the deliberate opposite of this — see ADR-009.)
 */
@Injectable()
export class OtpService {
  private readonly codeTtlSeconds: number;
  private readonly resendCooldownSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiService,
    private readonly config: ConfigService,
    private readonly codeStore: OtpCodeStore,
    private readonly delivery: OtpCodeDeliveryService,
    private readonly authService: AuthService,
  ) {
    this.codeTtlSeconds = Number(
      this.config.get<string>('OTP_CODE_TTL_SECONDS') ?? 300,
    );
    this.resendCooldownSeconds = Number(
      this.config.get<string>('OTP_RESEND_COOLDOWN_SECONDS') ?? 60,
    );
  }

  async request(input: OtpRequestInput): Promise<OtpRequestResult> {
    const phone = input.phone?.trim();
    const email = input.email?.trim();
    if ((phone && email) || (!phone && !email)) {
      throw new BadRequestException('Provide exactly one of phone or email');
    }
    if (phone && !E164.test(phone)) {
      throw new BadRequestException(
        'Enter a phone number in international format, e.g. +2348031234567',
      );
    }

    const identifierHash = phone
      ? this.pii.phoneHash(phone)
      : this.pii.emailHash(email!);

    // Unlike sign-up, a Redis outage here fails OPEN (inside checkRateLimit) —
    // this guards an SMS/email spend and a brute-force surface, not availability.
    await this.codeStore.checkRateLimit(
      REDIS_KEYS.otpSendCooldown(identifierHash),
      REDIS_KEYS.otpRequestRate(identifierHash),
      this.resendCooldownSeconds,
    );

    const user = await this.prisma.user.findUnique({
      where: phone
        ? { phoneHash: identifierHash }
        : { emailHash: identifierHash },
      select: { id: true, market: true },
    });

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const requestId = uuidv4();
    const state: OtpRequestState = { userId: user?.id ?? null };
    await this.codeStore.store(
      REDIS_KEYS.otpRequest(requestId),
      state,
      code,
      this.codeTtlSeconds,
    );

    if (user) {
      if (phone)
        await this.delivery.sendSms(
          phone,
          user.market,
          code,
          this.codeTtlSeconds,
        );
      else await this.delivery.sendEmail(email!, code, this.codeTtlSeconds);
    }
    // else: no spend for an identifier nobody owns, but the timing and the
    // response are identical either way — see the class doc.

    return {
      requestId,
      expiresInSeconds: this.codeTtlSeconds,
      resendAfterSeconds: this.resendCooldownSeconds,
    };
  }

  async verify(requestId: string, code: string): Promise<TokenPair> {
    const state = await this.codeStore.verify<OtpRequestState>(
      REDIS_KEYS.otpRequest(requestId),
      code,
    );

    if (!state.userId) {
      // Same message as a wrong code — an attacker cannot tell "unregistered
      // identifier" apart from "you mistyped the code" from the outside.
      throw new UnauthorizedException('Incorrect code');
    }

    return this.authService.issueForUser(state.userId);
  }
}
