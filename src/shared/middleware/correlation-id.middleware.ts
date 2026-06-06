// src/shared/middleware/correlation-id.middleware.ts

import { Injectable, NestMiddleware } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Ensures every request has a correlation ID.
 * If upstream provides x-correlation-id, we use it (distributed tracing).
 * Otherwise we generate a fresh UUID.
 * The ID is echoed back in the response header so clients can trace issues.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    next: () => void,
  ): void {
    const existing = (req.headers as Record<string, string>)[
      'x-correlation-id'
    ];
    const correlationId =
      typeof existing === 'string' && existing.length > 0 ? existing : uuidv4();

    (req.headers as Record<string, string>)['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    next();
  }
}
