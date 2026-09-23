// src/health/health.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { KafkaService } from '../infrastructure/kafka/kafka.service';
import { REDIS_KEYS } from '../shared/constants/redis-keys';
import { RabbitMQService } from '../infrastructure/rabbitmq/rabbitmq.service';

export interface ComponentHealth {
  status: 'up' | 'down' | 'degraded';
  responseTimeMs?: number;
  detail?: string;
}

/** Delivery providers whose circuit-breaker state is reported by /health. */
export const PROVIDER_NAMES = [
  'msg91',
  'termii',
  'twilio',
  'nodemailer',
  'fcm',
  'whatsapp_cloud',
  'in_app',
] as const;

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
    kafka: ComponentHealth;
    rabbitmq: ComponentHealth;
    providers: ComponentHealth;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly kafka: KafkaService,
    private readonly rabbitmq: RabbitMQService,
  ) {}

  async getHealth(): Promise<SystemHealth> {
    const [database, redisHealth, kafka, rabbitmq, providers] =
      await Promise.allSettled([
        this.checkDatabase(),
        this.checkRedis(),
        this.checkKafka(),
        this.checkRabbitMQ(),
        this.checkProviders(),
      ]);

    const components = {
      database: this.resolveCheck(database),
      redis: this.resolveCheck(redisHealth),
      kafka: this.resolveCheck(kafka),
      rabbitmq: this.resolveCheck(rabbitmq),
      providers: this.resolveCheck(providers),
    };

    const allUp = Object.values(components).every((c) => c.status === 'up');
    const anyDown = Object.values(components).some((c) => c.status === 'down');

    const status = allUp ? 'healthy' : anyDown ? 'unhealthy' : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: process.env.npm_package_version ?? '1.0.0',
      components,
    };
  }

  async isReady(): Promise<boolean> {
    // Readiness: database and redis must be up (minimum to serve traffic)
    try {
      const [db, red] = await Promise.all([
        this.checkDatabase(),
        this.checkRedis(),
      ]);
      return db.status === 'up' && red.status === 'up';
    } catch {
      return false;
    }
  }

  isAlive(): boolean {
    // Liveness: process is running and not deadlocked
    // If this endpoint responds, the process is alive
    return true;
  }

  // ── Individual checks ─────────────────────────────────────────────

  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'up',
        responseTimeMs: Date.now() - start,
      };
    } catch (err) {
      this.logger.error(
        `Database health check failed: ${(err as Error).message}`,
      );
      return {
        status: 'down',
        responseTimeMs: Date.now() - start,
        detail: (err as Error).message,
      };
    }
  }

  private async checkRedis(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const alive = await this.redis.ping();
      return {
        status: alive ? 'up' : 'down',
        responseTimeMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: 'down',
        responseTimeMs: Date.now() - start,
        detail: (err as Error).message,
      };
    }
  }

  private async checkKafka(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const alive = await this.kafka.ping();
      return {
        status: alive ? 'up' : 'down',
        responseTimeMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: 'down',
        responseTimeMs: Date.now() - start,
        detail: (err as Error).message,
      };
    }
  }

  private async checkRabbitMQ(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const alive = await this.rabbitmq.ping();
      return {
        status: alive ? 'up' : 'down',
        responseTimeMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: 'down',
        responseTimeMs: Date.now() - start,
        detail: (err as Error).message,
      };
    }
  }

  /**
   * Delivery providers, judged by their circuit breakers (spec Day 12: "check
   * all providers"). An OPEN or HALF_OPEN provider is `degraded`, never `down`:
   * SMS fails over to a secondary and other channels are unaffected, so the
   * engine still serves traffic. `detail` lists what is not CLOSED.
   */
  private async checkProviders(): Promise<ComponentHealth> {
    const start = Date.now();
    const unhealthy: string[] = [];

    for (const name of PROVIDER_NAMES) {
      const state = await this.redis.get(REDIS_KEYS.circuitBreakerState(name));
      if (state === 'OPEN' || state === 'HALF_OPEN') {
        unhealthy.push(`${name}=${state}`);
      }
    }

    return {
      status: unhealthy.length === 0 ? 'up' : 'degraded',
      responseTimeMs: Date.now() - start,
      ...(unhealthy.length > 0 && { detail: unhealthy.join(', ') }),
    };
  }

  private resolveCheck(
    result: PromiseSettledResult<ComponentHealth>,
  ): ComponentHealth {
    if (result.status === 'fulfilled') return result.value;
    return {
      status: 'down',
      detail:
        result.reason instanceof Error ? result.reason.message : 'Check failed',
    };
  }
}
