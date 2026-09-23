// tests/unit/api/middleware.spec.ts
import { EventEmitter } from 'events';
import { RequestLoggerMiddleware } from '../../../src/api/middleware/request-logger.middleware';
import { CorrelationIdMiddleware } from '../../../src/shared/middleware/correlation-id.middleware';

describe('CorrelationIdMiddleware — the trace id that follows a notification (spec A11.1 pillar 3)', () => {
  const run = (headers: Record<string, string>) => {
    const res = { setHeader: jest.fn() };
    const req = { headers };
    const next = jest.fn();
    new CorrelationIdMiddleware().use(req as never, res as never, next);
    return { req, res, next };
  };

  it('generates a UUID v4 when the caller sent none, and echoes it back', () => {
    const { req, res, next } = run({});
    expect(req.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      req.headers['x-correlation-id'],
    );
    expect(next).toHaveBeenCalled();
  });

  it('honours an upstream correlation id so a trace spans services', () => {
    const { req, res } = run({ 'x-correlation-id': 'abc-123' });
    expect(req.headers['x-correlation-id']).toBe('abc-123');
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'abc-123');
  });

  it('replaces an empty header with a fresh id', () => {
    expect(
      run({ 'x-correlation-id': '' }).req.headers['x-correlation-id'],
    ).toHaveLength(36);
  });
});

describe('RequestLoggerMiddleware', () => {
  const finish = (statusCode: number) => {
    const mw = new RequestLoggerMiddleware();
    const logger = (
      mw as unknown as { logger: Record<'log' | 'warn' | 'error', jest.Mock> }
    ).logger;
    logger.log = jest.fn();
    logger.warn = jest.fn();
    logger.error = jest.fn();
    const res = Object.assign(new EventEmitter(), { statusCode });
    const next = jest.fn();
    mw.use(
      {
        method: 'POST',
        url: '/api/v1/events',
        headers: { 'x-correlation-id': 'c-9' },
      } as never,
      res as never,
      next,
    );
    res.emit('finish');
    return { logger, next };
  };

  it('logs a success at info with method, url, status, duration and correlation id', () => {
    const { logger, next } = finish(202);
    expect(next).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^POST \/api\/v1\/events 202 \d+ms correlationId=c-9$/,
      ),
    );
  });
  it('logs 4xx at warn and 5xx at error (so production WARN level still shows failures)', () => {
    expect(finish(404).logger.warn).toHaveBeenCalled();
    expect(finish(500).logger.error).toHaveBeenCalled();
  });
});
