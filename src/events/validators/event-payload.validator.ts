// src/events/validators/event-payload.validator.ts
import { z } from 'zod';
import type { FieldError } from '../../shared/pipes/validation.pipe';

/**
 * Zod schemas for validating event payloads per event type.
 * These run at the API boundary, BEFORE anything is claimed, published or
 * stored. An invalid event is rejected with HTTP 422 and per-field errors in the
 * shape spec Appendix A prescribes:
 *   { field: "payload.shortfall_amount", error: "must be a positive number" }
 *
 * Event types without a dedicated schema get envelope validation only (the
 * payload is a JSON object); their templates degrade gracefully on missing
 * optional fields.
 */

const positive = z
  .number({ invalid_type_error: 'must be a number' })
  .positive('must be a positive number');
const nonNegative = z
  .number({ invalid_type_error: 'must be a number' })
  .nonnegative('must not be negative');
const isoDate = z
  .string()
  .datetime({ message: 'must be an ISO-8601 timestamp' });
const futureDate = isoDate.refine((v) => new Date(v).getTime() > Date.now(), {
  message: 'must be a future timestamp',
});
const text = z
  .string({ required_error: 'is required' })
  .min(1, 'must not be empty');

const baseSchema = z.object({
  eventType: z.string(),
  eventId: z.string().min(1),
  sourceSystem: z.string().min(1),
  timestamp: isoDate,
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)], {
    errorMap: () => ({
      message: 'must be one of 1 (CRITICAL), 2 (HIGH), 3 (MEDIUM), 5 (LOW)',
    }),
  }),
  userId: z.string().uuid('must be a UUID'),
  payload: z.record(z.unknown(), { invalid_type_error: 'must be an object' }),
  idempotencyKey: z.string().optional(),
});

// RISK-001 / RISK-002: margin call warning / shortfall
const marginPayload = z.object({
  shortfall_amount: positive,
  current_margin: nonNegative,
  required_margin: positive,
  deadline: futureDate,
  auto_square_off_time: isoDate,
});

// RISK-003: position squared off (no deadline — it has already happened)
const squaredOffPayload = z.object({
  positions_closed: z
    .array(z.unknown())
    .min(1, 'must list at least one closed position'),
});

const orderExecutedPayload = z.object({
  stock_name: text,
  symbol: text,
  qty: positive,
  price: positive,
  total: positive,
  order_id: text,
});

const orderRejectedPayload = z.object({
  order_id: text,
  reason: text,
});

const dividendPayload = z.object({
  company: text,
  amount: positive,
});

const fundsDepositedPayload = z.object({
  amount: positive,
  source: text,
});

const priceAlertPayload = z.object({
  symbol: text,
  stock_name: text.optional(),
  target_price: positive,
  current_price: positive,
  // accept ABOVE/above, BELOW/below
  direction: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(
      z.enum(['ABOVE', 'BELOW'], {
        errorMap: () => ({ message: 'must be ABOVE or BELOW' }),
      }),
    ),
});

const withPayload = (payload: z.ZodTypeAny) => baseSchema.extend({ payload });

export const EVENT_VALIDATORS: Record<string, z.ZodSchema> = {
  'RISK-001': withPayload(marginPayload),
  'RISK-002': withPayload(marginPayload),
  'RISK-003': withPayload(squaredOffPayload),
  'TXNX-001': withPayload(orderExecutedPayload),
  'TXNX-002': withPayload(orderExecutedPayload),
  'TXNX-003': withPayload(orderRejectedPayload),
  'TXNX-004': withPayload(dividendPayload),
  'TXNX-005': withPayload(fundsDepositedPayload),
  'MKTX-001': withPayload(priceAlertPayload),
  'MKTX-002': withPayload(priceAlertPayload),
};

const snake = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** `["payload","deadline"]` → `payload.deadline`; top-level DTO keys are snake_cased. */
function fieldPath(path: Array<string | number>): string {
  return path
    .map((seg, i) =>
      i === 0 && typeof seg === 'string' ? snake(seg) : String(seg),
    )
    .join('.');
}

/** Validates a full ingest request; returns one FieldError per problem. */
export function validateEvent(event: { eventType: string }): FieldError[] {
  const schema = EVENT_VALIDATORS[event.eventType] ?? baseSchema;
  const result = schema.safeParse(event);
  if (result.success) return [];
  return result.error.issues.map((i) => ({
    field: fieldPath(i.path),
    error: i.message,
  }));
}

/** Backwards-compatible boolean form. */
export function validateEventPayload(
  eventType: string,
  data: unknown,
): { valid: boolean; errors?: string[] } {
  const errors = validateEvent({ ...(data as object), eventType });
  return errors.length
    ? { valid: false, errors: errors.map((e) => `${e.field}: ${e.error}`) }
    : { valid: true };
}
