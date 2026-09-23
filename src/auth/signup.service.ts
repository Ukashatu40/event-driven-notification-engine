// src/auth/signup.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Language, Market } from '@prisma/client';
import { randomInt } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PiiService } from '../shared/pii/pii.service';
import { REDIS_KEYS } from '../shared/constants/redis-keys';
import { defaultPreferenceRows } from '../shared/defaults/default-preferences';
import { getMarketProfile } from '../shared/markets/market-profiles';
import { AuthService, type TokenPair } from './auth.service';
import { OtpCodeStore } from './otp-code-store.service';
import { OtpCodeDeliveryService } from './otp-code-delivery.service';

const E164 = /^\+[1-9]\d{6,14}$/;

export interface SignupRequestInput {
  name: string;
  phone?: string;
  email?: string;
  market?: string;
  language?: string;
}

export interface SignupRequestResult {
  requestId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

interface PendingSignup {
  name: string;
  phone: string | null;
  email: string | null;
  market: Market;
  language: Language;
}

/**
 * Self-service sign-up. Shares its code-delivery and code-verification
 * machinery with login (`OtpCodeDeliveryService`, `OtpCodeStore`) but is a
 * deliberately DIFFERENT security posture (ADR-009): login hides whether an
 * identifier is registered; sign-up must say so plainly ("an account already
 * exists, sign in instead") — every real sign-up flow does, and there would
 * be no point in login hiding it if you could just try to sign up instead.
 *
 * Nothing is written to Postgres until the code is verified — a bot hammering
 * `request()` never creates a row, only a short-lived Redis entry.
 */
@Injectable()
export class SignupService {
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

  async request(input: SignupRequestInput): Promise<SignupRequestResult> {
    const name = input.name?.trim();
    if (!name || name.length < 2 || name.length > 255) {
      throw new BadRequestException('Enter your name');
    }
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

    const market = this.parseEnum(Market, input.market, Market.IN);
    const language = this.parseEnum(Language, input.language, Language.EN);

    const identifierHash = phone
      ? this.pii.phoneHash(phone)
      : this.pii.emailHash(email!);

    await this.codeStore.checkRateLimit(
      REDIS_KEYS.signupSendCooldown(identifierHash),
      REDIS_KEYS.signupRequestRate(identifierHash),
      this.resendCooldownSeconds,
    );

    // Unlike login, sign-up MUST say this — see the class doc.
    const existing = await this.prisma.user.findUnique({
      where: phone
        ? { phoneHash: identifierHash }
        : { emailHash: identifierHash },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `An account with this ${phone ? 'phone number' : 'email'} already exists — sign in instead`,
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const requestId = uuidv4();
    const pending: PendingSignup = {
      name,
      phone: phone ?? null,
      email: email ?? null,
      market,
      language,
    };
    await this.codeStore.store(
      REDIS_KEYS.signupRequest(requestId),
      pending,
      code,
      this.codeTtlSeconds,
    );

    if (phone)
      await this.delivery.sendSms(phone, market, code, this.codeTtlSeconds);
    else await this.delivery.sendEmail(email!, code, this.codeTtlSeconds);

    return {
      requestId,
      expiresInSeconds: this.codeTtlSeconds,
      resendAfterSeconds: this.resendCooldownSeconds,
    };
  }

  async verify(requestId: string, code: string): Promise<TokenPair> {
    const pending = await this.codeStore.verify<PendingSignup>(
      REDIS_KEYS.signupRequest(requestId),
      code,
    );

    // A concurrent sign-up for the same identifier could have completed
    // between request() and verify() — the unique index on phoneHash/
    // emailHash is the real guard; this just gives a clear error instead of
    // a raw constraint violation.
    const identifierHash = pending.phone
      ? this.pii.phoneHash(pending.phone)
      : this.pii.emailHash(pending.email!);
    const alreadyExists = await this.prisma.user.findUnique({
      where: pending.phone
        ? { phoneHash: identifierHash }
        : { emailHash: identifierHash },
      select: { id: true },
    });
    if (alreadyExists) {
      throw new ConflictException(
        'An account with this contact detail already exists — sign in instead',
      );
    }

    const user = await this.prisma.user.create({
      data: {
        name: pending.name,
        email: this.pii.encrypt(pending.email ?? this.placeholderEmail()),
        emailHash: pending.email ? this.pii.emailHash(pending.email) : null,
        phone: this.pii.encrypt(pending.phone ?? this.placeholderPhone()),
        phoneHash: pending.phone ? this.pii.phoneHash(pending.phone) : null,
        market: pending.market,
        language: pending.language,
        // The column default (Asia/Kolkata) is only right for IN — without
        // this, every NG sign-up would silently get India's quiet-hours/
        // digest-scheduling timezone. getMarketProfile() is the one place
        // that already maps a market to its default timezone.
        timezone: getMarketProfile(pending.market).timezone,
        isActive: true,
      },
    });

    // Same starter preferences as npm run seed:me — never fabricated
    // consent, though: that starts empty and genuine for every real account.
    await this.prisma.userPreference.createMany({
      data: defaultPreferenceRows(user.id),
    });

    return this.authService.issueForUser(user.id);
  }

  private parseEnum<T extends Record<string, string>>(
    enumObj: T,
    value: string | undefined,
    fallback: T[keyof T],
  ): T[keyof T] {
    const upper = value?.toUpperCase();
    return upper && upper in enumObj ? (upper as T[keyof T]) : fallback;
  }

  /** phone/email are non-nullable columns; the identifier the user DIDN'T give gets an encrypted, non-identifying placeholder. */
  private placeholderEmail(): string {
    return `no-email-${uuidv4().slice(0, 8)}@unset.invalid`;
  }
  private placeholderPhone(): string {
    return '+10000000000';
  }
}
