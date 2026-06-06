// src/shared/exceptions/global-exception.filter.ts

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeForLog } from '../utils/pii-masker.util';

interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  requestId: string;
  correlationId: string;
  timestamp: string;
  path: string;
  details?: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const correlationId =
      (request.headers['x-correlation-id'] as string) ?? uuidv4();

    const requestId = uuidv4();

    let errorBody: string;
    let message: string;
    let details: unknown;

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        errorBody = (r['error'] as string) ?? 'HTTP_ERROR';
        message = (r['message'] as string) ?? exception.message;
        details = r['details'];
      } else {
        errorBody = 'HTTP_ERROR';
        message = String(response);
      }
    } else if (exception instanceof Error) {
      errorBody = 'INTERNAL_SERVER_ERROR';
      message =
        process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : exception.message;
    } else {
      errorBody = 'UNKNOWN_ERROR';
      message = 'An unexpected error occurred';
    }

    const responseBody: ErrorResponse = {
      error: errorBody,
      message,
      statusCode,
      requestId,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(details !== undefined && { details }),
    };

    // Log with sanitized context — never log PII
    if (statusCode >= 500) {
      this.logger.error(
        {
          ...sanitizeForLog({ path: request.url, method: request.method }),
          statusCode,
          correlationId,
          error:
            exception instanceof Error ? exception.stack : String(exception),
        },
        `Unhandled exception: ${message}`,
      );
    } else if (statusCode >= 400) {
      this.logger.warn(
        {
          path: request.url,
          statusCode,
          correlationId,
          error: errorBody,
        },
        `Client error: ${message}`,
      );
    }

    void reply.status(statusCode).send(responseBody);
  }
}
