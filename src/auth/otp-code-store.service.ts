// src/auth/otp-code-store.service.ts
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { RedisService } from '../infrastructure/redis/redis.service';

interface CodeAttemptState<T> {
  payload: T;
  codeHash: string;
  attempts: number;
}

/**
 * The Redis-backed "6-digit code, N attempts, single-use" state machine
 * shared by login (`OtpService`) and sign-up (`SignupService`) — the exact
 * same security-sensitive logic (timing-safe compare, attempts-exhaustion
 * invalidates the whole code not just the guess, single-use delete on
 * success) lived only in `OtpService.verify()` before sign-up needed it too.
 * One place to get it right; one place to fix it if it's ever wrong.
 *
 * Callers own their own Redis key namespace (`REDIS_KEYS.otpRequest(...)` vs
 * `.signupRequest(...)`) and the shape of `T` — this class only knows about
 * the code/attempts envelope around it.
 */
@Injectable()
export class OtpCodeStore {
  private readonly logger = new Logger(OtpCodeStore.name);
  private readonly maxAttempts: number;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.maxAttempts = Number(this.config.get<string>('OTP_MAX_ATTEMPTS') ?? 5);
  }

  /** Rejects a request within the resend cooldown or over the rate limit for this identifier. Fail-open on a Redis outage. */
  async checkRateLimit(
    cooldownKey: string,
    rateKey: string,
    resendCooldownSeconds: number,
  ): Promise<void> {
    const client = this.redis.getClient();
    try {
      if (await client.exists(cooldownKey)) {
        throw new UnauthorizedException(
          'Please wait before requesting another code',
        );
      }
      const requestCount = await client.incr(rateKey);
      if (requestCount === 1) {
        await client.expire(rateKey, 900); // 15 min window
      }
      if (requestCount > 3) {
        throw new UnauthorizedException(
          'Too many codes requested — try again later',
        );
      }
      await client
        .set(cooldownKey, '1', 'EX', resendCooldownSeconds)
        .catch(() => undefined);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(
        `OTP rate-limit check failed open: ${(err as Error).message}`,
      );
    }
  }

  async store<T>(
    key: string,
    payload: T,
    code: string,
    ttlSeconds: number,
  ): Promise<void> {
    const state: CodeAttemptState<T> = {
      payload,
      codeHash: this.hashCode(code),
      attempts: 0,
    };
    await this.redis
      .getClient()
      .set(key, JSON.stringify(state), 'EX', ttlSeconds);
  }

  /**
   * Verifies `code` against what's stored at `key`. Returns the payload on
   * success and deletes the key (single-use). Every failure — expired,
   * wrong code, too many attempts — throws `UnauthorizedException` with a
   * message that reveals nothing about *why* beyond that: callers must not
   * layer their own "was this even a real identifier" distinction on top.
   */
  async verify<T>(key: string, code: string): Promise<T> {
    const client = this.redis.getClient();
    const raw = await client.get(key);
    if (!raw) {
      throw new UnauthorizedException(
        'That code has expired — request a new one',
      );
    }

    const state = JSON.parse(raw) as CodeAttemptState<T>;
    if (!this.safeEqual(this.hashCode(code), state.codeHash)) {
      state.attempts += 1;
      if (state.attempts >= this.maxAttempts) {
        await client.del(key);
        throw new UnauthorizedException(
          'Too many incorrect attempts — request a new code',
        );
      }
      const ttl = await client.ttl(key);
      await client.set(key, JSON.stringify(state), 'EX', Math.max(1, ttl));
      throw new UnauthorizedException('Incorrect code');
    }

    await client.del(key);
    return state.payload;
  }

  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}
