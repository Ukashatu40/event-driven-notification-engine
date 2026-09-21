// src/templates/engine/ab-testing.service.ts
import { Injectable } from '@nestjs/common';
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
    const variants = await (this.prisma as any).template.findMany({
      where: {
        eventType,
        isActive: true,
      },
      orderBy: { version: 'asc' },
    });

    if (variants.length === 0) {
      throw new Error(`No active template found for event type ${eventType}`);
    }

    const control =
      variants.find((v: Record<string, unknown>) => !v['isAbVariant']) ??
      variants[0];
    const activeVariants = variants.filter(
      (v: Record<string, unknown>) => v['isAbVariant'],
    );

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
      abWeight:
        100 -
        activeVariants.reduce(
          (sum: number, v: Record<string, unknown>) =>
            sum + (v['abWeight'] as number),
          0,
        ),
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
      significanceVsControl: {
        deliveryRatePValue: number;
        readRatePValue: number;
        isSignificant: boolean;
        confidenceLevel: number;
        winner: 'variant' | 'control' | 'no_difference';
      } | null;
    }>
  > {
    const variants = await (this.prisma as any).template.findMany({
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

      const exposureCount =
        typeof exposures === 'number'
          ? exposures
          : parseInt(String(exposures ?? '0'), 10);
      const deliveredCount = parseInt(delivered ?? '0', 10);
      const readCount = parseInt(read ?? '0', 10);

      results.push({
        templateId: variant.id,
        version: variant.version,
        isAbVariant: variant.isAbVariant,
        exposures: exposureCount,
        delivered: deliveredCount,
        read: readCount,
        deliveryRate: exposureCount > 0 ? deliveredCount / exposureCount : 0,
        readRate: deliveredCount > 0 ? readCount / deliveredCount : 0,
        significanceVsControl: null as unknown as {
          deliveryRatePValue: number;
          readRatePValue: number;
          isSignificant: boolean;
          confidenceLevel: number;
          winner: 'variant' | 'control' | 'no_difference';
        } | null,
      });
    }

    // Statistical significance: two-proportion z-test (spec B3.4: "with statistical significance calculation")
    // Uses 95% confidence threshold (α = 0.05, z-critical = 1.96)
    const control = results.find((r) => !r.isAbVariant);
    if (control) {
      for (const result of results) {
        if (!result.isAbVariant) continue;

        result.significanceVsControl = this.calculateSignificance(
          control.exposures,
          control.delivered,
          result.exposures,
          result.delivered,
          control.read,
          result.read,
        );
      }
    }

    return results;
  }

  /**
   * Two-proportion z-test for statistical significance.
   * Spec B3.4: "A/B testing for notification templates with statistical significance calculation"
   *
   * Tests H0: p_control == p_variant at 95% confidence level (z_critical = 1.96).
   * Returns p-value approximation from z-score using the complementary error function.
   *
   * @returns significance object with p-values and winner determination
   */
  private calculateSignificance(
    controlN: number,
    controlDelivered: number,
    variantN: number,
    variantDelivered: number,
    controlRead: number,
    variantRead: number,
  ): {
    deliveryRatePValue: number;
    readRatePValue: number;
    isSignificant: boolean;
    confidenceLevel: number;
    winner: 'variant' | 'control' | 'no_difference';
  } {
    const Z_CRITICAL = 1.96; // 95% confidence
    const MIN_SAMPLE = 30; // minimum sample size for valid z-test

    const deliveryZ = this.twoProportionZ(
      controlN,
      controlDelivered,
      variantN,
      variantDelivered,
    );
    const readZ = this.twoProportionZ(
      controlN,
      controlRead,
      variantN,
      variantRead,
    );

    const deliveryPValue = this.zToPValue(deliveryZ);
    const readPValue = this.zToPValue(readZ);

    const hasEnoughData = controlN >= MIN_SAMPLE && variantN >= MIN_SAMPLE;
    const isSignificant =
      hasEnoughData &&
      (Math.abs(deliveryZ) > Z_CRITICAL || Math.abs(readZ) > Z_CRITICAL);

    const controlDeliveryRate = controlN > 0 ? controlDelivered / controlN : 0;
    const variantDeliveryRate = variantN > 0 ? variantDelivered / variantN : 0;

    let winner: 'variant' | 'control' | 'no_difference' = 'no_difference';
    if (isSignificant) {
      winner =
        variantDeliveryRate > controlDeliveryRate ? 'variant' : 'control';
    }

    return {
      deliveryRatePValue: Math.round(deliveryPValue * 10000) / 10000,
      readRatePValue: Math.round(readPValue * 10000) / 10000,
      isSignificant,
      confidenceLevel: 0.95,
      winner,
    };
  }

  /** Two-proportion z-score: (p1 - p2) / sqrt(p_pool * (1-p_pool) * (1/n1 + 1/n2)) */
  private twoProportionZ(
    n1: number,
    x1: number,
    n2: number,
    x2: number,
  ): number {
    if (n1 === 0 || n2 === 0) return 0;
    const p1 = x1 / n1;
    const p2 = x2 / n2;
    const pPool = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
    return se === 0 ? 0 : (p1 - p2) / se;
  }

  /**
   * Approximates two-tailed p-value from z-score.
   * Uses Abramowitz & Stegun rational approximation (error < 1.5e-7).
   */
  private zToPValue(z: number): number {
    const absZ = Math.abs(z);
    const t = 1 / (1 + 0.2316419 * absZ);
    const poly =
      t *
      (0.31938153 +
        t *
          (-0.356563782 +
            t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const pdf = Math.exp(-0.5 * absZ * absZ) / Math.sqrt(2 * Math.PI);
    const oneTail = pdf * poly;
    return Math.min(1, 2 * oneTail); // two-tailed
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
