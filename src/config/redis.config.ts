// src/config/redis.config.ts

import { registerAs } from '@nestjs/config';

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD ?? '',
  db: parseInt(process.env.REDIS_DB ?? '0', 10),
  // Explicit, like KAFKA_SSL — never inferred from NODE_ENV. Needed for a
  // managed TLS-only Redis (e.g. Upstash); the bundled compose Redis is plaintext.
  tls: process.env.REDIS_TLS === 'true',
  // Connection options tuned for high-throughput frequency capping
  connectTimeout: 10_000,
  commandTimeout: 5_000,
  maxRetriesPerRequest: 3,
  // For cluster mode (production scale-out path)
  // enableCluster: process.env.REDIS_CLUSTER === 'true',
  // clusterNodes: (process.env.REDIS_CLUSTER_NODES ?? '').split(','),
  lazyConnect: false,
  keepAlive: 30_000,
  family: 4,
}));
