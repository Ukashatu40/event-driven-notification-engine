// src/templates/engine/ab-testing.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { createHash } from 'crypto';

export interface TemplateVariant {
  templateId: string;
  version: number;
  isAbVariant: boolean;
  abWeight: number;
}

/**
 * A/B testing for notification templates.
 *
 * Deterministic bucketing: the same user always gets the same variant
 * for a given event type, computed via consistent hashing on (userId + eventType).
 * This means a user's experience is stable across multiple sends of the
 * same event type, which is required for meaningful A/B comparison.
 *
 * Weight is a percentage (0-100) of traffic that should see the variant.
 * The control (non-variant, version 1) gets the remainder.
 */
@Injectable()
export class AbTestingService {
  private readonly logger = new Logger(AbTestingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Resolves which template version a user should see for an event type.
   * Returns the control version if no active A/B variant exists.
   */
  async resolveVariant(
    userId: string,
    eventType: string,
  ): Promise<TemplateVariant> {
    this.logger.debug('Debugging');
    const variants = await this.prisma.template.findMany({
      where: {
        eventType,
        isActive: true,
      },
      orderBy: { version: 'asc' },
    });

    if (variants.length === 0) {
      throw new Error(`No active template found for event type ${eventType}`);
    }

    const control = variants.find((v) => !v.isAbVariant) ?? variants[0];
    const activeVariants = variants.filter((v) => v.isAbVariant);

    if (activeVariants.length === 0) {
      return {
        templateId: control.id,
        version: control.version,
        isAbVariant: false,
        abWeight: 100,
      };
    }

    // Deterministic bucket: hash(userId + eventType) -> 0-99
    const bucket = this.getBucket(userId, eventType);

    // Allocate buckets to variants in order, remainder goes to control
    let cumulativeWeight = 0;
    for (const variant of activeVariants) {
      cumulativeWeight += variant.abWeight;
      if (bucket < cumulativeWeight) {
        return {
          templateId: variant.id,
          version: variant.version,
          isAbVariant: true,
          abWeight: variant.abWeight,
        };
      }
    }

    // Bucket falls outside all variant allocations -> control
    return {
      templateId: control.id,
      version: control.version,
      isAbVariant: false,
      abWeight: 100 - activeVariants.reduce((sum, v) => sum + v.abWeight, 0),
    };
  }

  /**
   * Records which variant a user was shown, for later conversion analysis.
   * Stored in Redis with 90-day TTL — long enough for monthly cohort analysis.
   */
  async recordExposure(
    userId: string,
    eventType: string,
    templateId: string,
    notificationId: string,
  ): Promise<void> {
    const key = `ab:exposure:${eventType}:${templateId}`;
    await this.redis.getClient().sadd(key, `${userId}:${notificationId}`);
    await this.redis.getClient().expire(key, 90 * 24 * 60 * 60);
  }

  /**
   * Records a conversion event (delivered, read, clicked) against a variant.
   * Used to compute lift between control and variant.
   */
  async recordConversion(
    eventType: string,
    templateId: string,
    conversionType: 'delivered' | 'read',
  ): Promise<void> {
    const key = `ab:conversion:${eventType}:${templateId}:${conversionType}`;
    await this.redis.getClient().incr(key);
    await this.redis.getClient().expire(key, 90 * 24 * 60 * 60);
  }

  /**
   * Returns aggregate performance for each variant of an event type.
   * Used by the analytics dashboard to decide whether to promote a variant.
   */
  async getVariantPerformance(eventType: string): Promise<
    Array<{
      templateId: string;
      version: number;
      isAbVariant: boolean;
      exposures: number;
      delivered: number;
      read: number;
      deliveryRate: number;
      readRate: number;
    }>
  > {
    const variants = await this.prisma.template.findMany({
      where: { eventType, isActive: true },
    });

    const results = [];

    for (const variant of variants) {
      const exposureKey = `ab:exposure:${eventType}:${variant.id}`;
      const deliveredKey = `ab:conversion:${eventType}:${variant.id}:delivered`;
      const readKey = `ab:conversion:${eventType}:${variant.id}:read`;

      const [exposures, delivered, read] = await Promise.all([
        this.redis.getClient().scard(exposureKey),
        this.redis.get(deliveredKey),
        this.redis.get(readKey),
      ]);

      const deliveredCount = parseInt(delivered ?? '0', 10);
      const readCount = parseInt(read ?? '0', 10);

      results.push({
        templateId: variant.id,
        version: variant.version,
        isAbVariant: variant.isAbVariant,
        exposures,
        delivered: deliveredCount,
        read: readCount,
        deliveryRate: exposures > 0 ? deliveredCount / exposures : 0,
        readRate: deliveredCount > 0 ? readCount / deliveredCount : 0,
      });
    }

    return results;
  }

  private getBucket(userId: string, eventType: string): number {
    const hash = createHash('sha256')
      .update(`${userId}:${eventType}`)
      .digest('hex');
    // Take first 8 hex chars as a number, mod 100 for a 0-99 bucket
    const num = parseInt(hash.slice(0, 8), 16);
    return num % 100;
  }
}
