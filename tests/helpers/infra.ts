// tests/helpers/infra.ts
import 'reflect-metadata';
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { createConnection } from 'net';
import { Pool } from 'pg';

/** "host:port[/path]" → [host, port], with defaults for anything missing. */
function hostPort(
  value: string | undefined,
  host: string,
  port: number,
): [string, number] {
  const [h, p] = (value ?? '').split('/')[0].split(':');
  return [h || host, Number(p) || port];
}

/** True if something is listening on host:port (no protocol handshake). */
export function portOpen(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Integration/e2e tests need real Postgres, Redis, Kafka and RabbitMQ
 * (`docker compose up -d`; CI uses docker-compose.test.yml). When they are not
 * reachable the suite is SKIPPED with a clear message rather than failing, so
 * `npm test` stays green on a laptop with nothing running — but CI sets
 * REQUIRE_INFRA=true, which turns "infra missing" into a hard failure so the
 * suite can never silently pass by not running.
 */
export async function infraAvailable(): Promise<boolean> {
  const db = new URL(
    process.env.DATABASE_URL ?? 'postgresql://x@localhost:5433/x',
  );
  const checks = await Promise.all([
    portOpen(db.hostname, Number(db.port || 5432)),
    portOpen(
      process.env.REDIS_HOST ?? 'localhost',
      Number(process.env.REDIS_PORT ?? 6379),
    ),
    portOpen(
      ...hostPort(process.env.KAFKA_BROKERS?.split(',')[0], 'localhost', 9092),
    ),
    portOpen(
      ...hostPort(
        process.env.RABBITMQ_URL?.replace(/^amqps?:\/\/[^@]*@?/, ''),
        'localhost',
        5672,
      ),
    ),
  ]);
  const ok = checks.every(Boolean);
  if (!ok && process.env.REQUIRE_INFRA === 'true') {
    throw new Error(
      `REQUIRE_INFRA=true but infrastructure is not reachable (db/redis/kafka/rabbit = ${checks.join('/')})`,
    );
  }
  return ok;
}

/** A plain pg pool for assertions that should not depend on the app's own code. */
export const rawPool = (): Pool =>
  new Pool({ connectionString: process.env.DATABASE_URL });
