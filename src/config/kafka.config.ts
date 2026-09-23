// src/config/kafka.config.ts

import { registerAs } from '@nestjs/config';

export const kafkaConfig = registerAs('kafka', () => ({
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  clientId: process.env.KAFKA_CLIENT_ID ?? 'notification-engine',
  groupIds: {
    standard: process.env.KAFKA_GROUP_ID_STANDARD ?? 'notification-standard-cg',
    critical: process.env.KAFKA_GROUP_ID_CRITICAL ?? 'notification-critical-cg',
    analytics: 'notification-analytics-cg',
    dlq: 'notification-dlq-cg',
  },
  // Topics — all defined centrally, never hardcoded downstream
  topics: {
    events: 'notification-events',
    critical: 'notification-critical',
    routing: 'notification-routing',
    delivery: 'notification-delivery',
    status: 'notification-status',
    analytics: 'notification-analytics',
    dlq: 'notification-dlq',
  },
  // Producer config — idempotent to prevent duplicates on retry
  producer: {
    idempotent: true,
    maxInFlightRequests: 5, // required when idempotent = true
    acks: -1, // wait for all in-sync replicas
    compressionType: 'gzip',
    retries: 10,
    initialRetryTime: 100,
    retryFactor: 2,
  },
  // Consumer config — tuned to minimize rebalance disruption at peak load
  consumer: {
    sessionTimeoutMs: 45_000,
    heartbeatIntervalMs: 15_000, // must be < sessionTimeoutMs / 3
    maxPollIntervalMs: 300_000,
    rebalanceTimeoutMs: 60_000,
    allowAutoTopicCreation: false, // topics must be pre-created explicitly
    fromBeginning: false,
  },
  // Explicit, NOT inferred from NODE_ENV: a production-mode container talking to
  // a plaintext broker (docker compose) must be able to connect. Set
  // KAFKA_SSL=true for a TLS broker (managed Kafka, Confluent Cloud, …).
  ssl: process.env.KAFKA_SSL === 'true',
  // Some managed Kafka providers (Aiven, notably) terminate TLS with a
  // certificate signed by their OWN CA, not a publicly trusted one — `ssl:
  // true` alone verifies against Node's public root store and fails with
  // "self-signed certificate in certificate chain". Paste that provider's CA
  // certificate (PEM) here to fix it; left empty, `ssl: true` behaves exactly
  // as before for a broker with a real public CA.
  sslCa: process.env.KAFKA_SSL_CA ?? '',
  // Some Aiven Kafka services require mutual TLS (a client cert) at the raw
  // TLS layer, independent of SASL — see kafka.service.ts. Both from the
  // same Aiven console page as the CA: "Access Certificate" / "Access Key".
  sslClientCert: process.env.KAFKA_SSL_CLIENT_CERT ?? '',
  sslClientKey: process.env.KAFKA_SSL_CLIENT_KEY ?? '',
  sasl:
    process.env.KAFKA_SASL_USERNAME && process.env.KAFKA_SASL_PASSWORD
      ? {
          mechanism: 'plain' as const,
          username: process.env.KAFKA_SASL_USERNAME,
          password: process.env.KAFKA_SASL_PASSWORD,
        }
      : undefined,
}));
