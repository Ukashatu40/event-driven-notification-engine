// src/api/interceptors/response-transform.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { snakeKeys } from '../../shared/utils/case.util';

/**
 * Serialises successful responses to the documented contract (spec Appendix A):
 * the bare body with snake_case keys — no `{success, data}` envelope.
 *
 * Correlation ids travel in the `x-correlation-id` header (set by the
 * correlation-id middleware), not in the body. Errors are shaped by
 * GlobalExceptionFilter.
 */
@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map((data) => snakeKeys(data)));
  }
}
