// src/shared/decorators/correlation-id.decorator.ts

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { FastifyRequest } from 'fastify';

/**
 * Extracts or generates the correlation ID from request headers.
 * Every notification is traceable end-to-end via this ID.
 * Injected into Kafka message headers, logs, and DB records.
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    const existing = request.headers['x-correlation-id'];

    if (typeof existing === 'string' && existing.length > 0) {
      return existing;
    }

    // Generate new if not provided by upstream service
    return uuidv4();
  },
);
