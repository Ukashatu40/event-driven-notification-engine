// src/events/validators/event-payload.validator.ts
import { z } from 'zod';

/**
 * Zod schemas for validating event payloads per event type.
 * These run BEFORE the notification is created in the database.
 * Invalid payloads are rejected at the API boundary.
 */

const baseSchema = z.object({
  eventType: z.string(),
  eventId: z.string(),
  sourceSystem: z.string(),
  timestamp: z.string().datetime(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]),
  userId: z.string().uuid(),
  payload: z.record(z.unknown()),
  idempotencyKey: z.string().optional(),
});

const riskPayloadSchema = z.object({
  shortfall_amount: z.number().positive(),
  current_margin: z.number().nonnegative(),
  required_margin: z.number().positive(),
  deadline: z.string().datetime(),
  auto_square_off_time: z.string().datetime(),
});

const transactionPayloadSchema = z.object({
  stock_name: z.string(),
  symbol: z.string(),
  qty: z.number().positive(),
  price: z.number().positive(),
  total: z.number().positive(),
  order_id: z.string(),
});

const priceAlertPayloadSchema = z.object({
  symbol: z.string(),
  stock_name: z.string(),
  target_price: z.number().positive(),
  current_price: z.number().positive(),
  direction: z.enum(['ABOVE', 'BELOW']),
});

export const EVENT_VALIDATORS: Record<string, z.ZodSchema> = {
  'RISK-001': baseSchema.extend({ payload: riskPayloadSchema }),
  'RISK-002': baseSchema.extend({ payload: riskPayloadSchema }),
  'RISK-003': baseSchema.extend({ payload: riskPayloadSchema }),
  'TXNX-001': baseSchema.extend({ payload: transactionPayloadSchema }),
  'TXNX-002': baseSchema.extend({ payload: transactionPayloadSchema }),
  'MKTX-001': baseSchema.extend({ payload: priceAlertPayloadSchema }),
  'MKTX-002': baseSchema.extend({ payload: priceAlertPayloadSchema }),
};

export function validateEventPayload(
  eventType: string,
  data: unknown,
): { valid: boolean; errors?: string[] } {
  const schema = EVENT_VALIDATORS[eventType];

  // Events without a specific schema use base validation only
  if (!schema) {
    const result = baseSchema.safeParse(data);
    return {
      valid: result.success,
      errors: result.success
        ? undefined
        : result.error.issues.map((i) => i.message),
    };
  }

  const result = schema.safeParse(data);
  return {
    valid: result.success,
    errors: result.success
      ? undefined
      : result.error.issues.map((i) => i.message),
  };
}
