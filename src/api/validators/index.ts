// src/api/validators/index.ts
//
// Everything that validates input at the API boundary, in one import:
//  - the single global ValidationPipe (strict, 422 VALIDATION_FAILED);
//  - per-event-type Zod payload schemas.
export {
  createValidationPipe,
  flattenValidationErrors,
  ValidationFailedException,
} from '../../shared/pipes/validation.pipe';
export type { FieldError } from '../../shared/pipes/validation.pipe';
export {
  EVENT_VALIDATORS,
  validateEvent,
  validateEventPayload,
} from '../../events/validators/event-payload.validator';
