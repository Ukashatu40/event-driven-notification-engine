// src/api/interceptors/request-case.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { camelKeys } from '../../shared/utils/case.util';

/**
 * Accepts the documented snake_case request bodies (`event_type`, `user_id`,
 * `digest_mode`, …) and hands the controllers camelCase, so the DTOs can stay
 * idiomatic. camelCase bodies keep working (conversion is idempotent).
 *
 * Runs only for the versioned API (/api/v1/…): provider webhooks under
 * /api/webhooks are signed over their exact bytes and parsed with the
 * providers' own key names, so they must not be touched. Interceptors run
 * before pipes, so validation sees the converted body.
 */
@Injectable()
export class RequestCaseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (
      request.url.startsWith('/api/v1/') &&
      request.body &&
      typeof request.body === 'object'
    ) {
      request.body = camelKeys(request.body);
    }
    return next.handle();
  }
}
