// src/delivery/circuit-breaker/circuit-breaker.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PrometheusService } from '../../health/prometheus/prometheus.service';
import { REDIS_KEYS, TTL } from '../../shared/constants/redis-keys';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitConfig {
  failureThreshold: number; // failures before opening
  successThreshold: number; // successes in HALF_OPEN before closing
  openDurationMs: number; // how long to stay OPEN
  windowMs: number; // sliding window for failure counting
}

/**
 * Circuit breaker with three states (Martin Fowler pattern).
 *
 * CLOSED  → normal operation, failures counted
 * OPEN    → all requests fail fast, no provider calls
 * HALF_OPEN → single probe request allowed, success → CLOSED, fail → OPEN
 *
 * State is stored in Redis so all instances share the same view.
 * This prevents one instance from opening while another is sending.
 *
 * Provider state is also persisted to PostgreSQL for the
 * compliance audit trail (B2.3 Challenge requirement).
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  private readonly DEFAULT_CONFIG: CircuitConfig = {
    failureThreshold: 5,
    successThreshold: 2,
    openDurationMs: 60_000, // 60 seconds
    windowMs: 60_000, // 60-second sliding window
  };

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly prometheus: PrometheusService,
  ) {}

  /**
   * Check if a request is allowed through the circuit.
   * Call this BEFORE making a provider API call.
   */
  async allowRequest(provider: string): Promise<boolean> {
    const state = await this.getState(provider);

    switch (state) {
      case 'CLOSED':
        return true;

      case 'OPEN': {
        // Check if open duration has elapsed → transition to HALF_OPEN
        const lastAttempt = await this.redis.get(
          REDIS_KEYS.circuitBreakerLastAttempt(provider),
        );

        if (!lastAttempt) {
          await this.transitionTo(provider, 'HALF_OPEN');
          return true; // allow one probe request
        }

        const elapsed = Date.now() - parseInt(lastAttempt, 10);
        if (elapsed >= this.DEFAULT_CONFIG.openDurationMs) {
          await this.transitionTo(provider, 'HALF_OPEN');
          return true;
        }

        return false; // still OPEN, fail fast
      }

      case 'HALF_OPEN':
        // Allow only one probe request
        return true;

      default:
        return true;
    }
  }

  /**
   * Record a successful provider call.
   * Call this AFTER a successful send.
   */
  async recordSuccess(provider: string): Promise<void> {
    const state = await this.getState(provider);

    if (state === 'HALF_OPEN') {
      // In HALF_OPEN, successes move toward CLOSED
      const key = `cb:${provider}:half_open_successes`;
      const successes = await this.redis.increment(key, 30);

      if (successes >= this.DEFAULT_CONFIG.successThreshold) {
        await this.transitionTo(provider, 'CLOSED');
        await this.redis.del(key);
      }
    }

    // Reset failure counter on success
    await this.redis.del(REDIS_KEYS.circuitBreakerFailures(provider));
  }

  /**
   * Record a failed provider call.
   * Call this AFTER a failed send.
   */
  async recordFailure(provider: string): Promise<void> {
    const state = await this.getState(provider);

    if (state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN → back to OPEN immediately
      await this.transitionTo(provider, 'OPEN');
      return;
    }

    if (state === 'OPEN') return; // already open, no action

    // CLOSED — increment failure counter
    const failures = await this.redis.increment(
      REDIS_KEYS.circuitBreakerFailures(provider),
      TTL.CIRCUIT_BREAKER_FAILURE_WINDOW,
    );

    if (failures >= this.DEFAULT_CONFIG.failureThreshold) {
      await this.transitionTo(provider, 'OPEN');
    }
  }

  async getState(provider: string): Promise<CircuitState> {
    const state = await this.redis.get(
      REDIS_KEYS.circuitBreakerState(provider),
    );
    return (state as CircuitState) ?? 'CLOSED';
  }

  async getFailureCount(provider: string): Promise<number> {
    const count = await this.redis.get(
      REDIS_KEYS.circuitBreakerFailures(provider),
    );
    return parseInt(count ?? '0', 10);
  }

  // ── State transitions ─────────────────────────────────────────────

  private async transitionTo(
    provider: string,
    newState: CircuitState,
  ): Promise<void> {
    const oldState = await this.getState(provider);
    if (oldState === newState) return;

    await this.redis.set(REDIS_KEYS.circuitBreakerState(provider), newState);

    await this.redis.set(
      REDIS_KEYS.circuitBreakerLastAttempt(provider),
      Date.now().toString(),
    );

    // Update Prometheus gauge
    // 0=CLOSED, 1=HALF_OPEN, 2=OPEN
    const channel = await this.getProviderChannel(provider);
    this.prometheus.setCircuitState(provider, channel, newState);

    // Persist to DB for audit trail
    await this.prisma.providerHealth.upsert({
      where: { provider },
      create: {
        provider,
        channel,
        circuitState: newState,
        failureCount:
          newState === 'OPEN' ? this.DEFAULT_CONFIG.failureThreshold : 0,
      },
      update: {
        circuitState: newState,
        ...(newState === 'OPEN' && { lastFailureAt: new Date() }),
        ...(newState === 'CLOSED' && {
          lastSuccessAt: new Date(),
          failureCount: 0,
        }),
      },
    });

    this.logger.warn(
      `Circuit breaker for ${provider}: ${oldState} → ${newState}`,
    );

    if (newState === 'OPEN') {
      this.logger.error(
        `🔴 Circuit OPEN for provider ${provider} — failing fast for ${this.DEFAULT_CONFIG.openDurationMs / 1000}s`,
      );
    }
  }

  private async getProviderChannel(provider: string): Promise<string> {
    const channelMap: Record<string, string> = {
      msg91: 'sms',
      twilio: 'sms',
      nodemailer: 'email',
      fcm: 'push',
      whatsapp_cloud: 'whatsapp',
      in_app: 'in_app',
    };
    return channelMap[provider] ?? 'unknown';
  }
}
