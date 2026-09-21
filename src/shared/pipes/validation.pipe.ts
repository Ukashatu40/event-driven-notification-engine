// src/shared/pipes/validation.pipe.ts
import {
  UnprocessableEntityException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';

export interface FieldError {
  field: string;
  error: string;
}

/** Flattens class-validator's nested errors into `{ field: "a.b.c", error }`. */
export function flattenValidationErrors(
  errors: ValidationError[],
  parent = '',
): FieldError[] {
  const out: FieldError[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    for (const message of Object.values(e.constraints ?? {})) {
      out.push({ field, error: message });
    }
    if (e.children?.length) {
      out.push(...flattenValidationErrors(e.children, field));
    }
  }
  return out;
}

/** Thrown for any failed input validation — HTTP 422, spec Appendix A shape. */
export class ValidationFailedException extends UnprocessableEntityException {
  constructor(details: FieldError[], message = 'Request validation failed') {
    super({ error: 'VALIDATION_FAILED', message, details });
  }
}

/**
 * The single ValidationPipe for the whole app (used by main.ts and the
 * SharedModule APP_PIPE so the two can never drift apart). Strict: unknown
 * fields are rejected, not silently dropped (spec A10.1.B).
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) =>
      new ValidationFailedException(flattenValidationErrors(errors)),
  });
}
