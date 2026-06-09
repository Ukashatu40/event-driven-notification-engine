// src/api/interceptors/response-transform.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { FastifyRequest } from 'fastify';

/**
 * Wraps all successful responses in a consistent envelope.
 * Error responses are handled by GlobalExceptionFilter.
 */
@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const correlationId =
      (request.headers['x-correlation-id'] as string) ?? 'none';

    return next.handle().pipe(
      map((data) => ({
        success: true,
        correlationId,
        timestamp: new Date().toISOString(),
        data,
      })),
    );
  }
}
