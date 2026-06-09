// src/api/middleware/request-logger.middleware.ts
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    next: () => void,
  ): void {
    const start = Date.now();
    const { method, url } = req;
    const correlationId =
      (req.headers as Record<string, string>)['x-correlation-id'] ?? 'none';

    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;

      const logFn =
        status >= 500
          ? this.logger.error.bind(this.logger)
          : status >= 400
            ? this.logger.warn.bind(this.logger)
            : this.logger.log.bind(this.logger);

      logFn(
        `${method} ${url} ${status} ${duration}ms correlationId=${correlationId}`,
      );
    });

    next();
  }
}
