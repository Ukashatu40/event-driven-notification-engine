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
  ssl: process.env.NODE_ENV === 'production',
  sasl:
    process.env.KAFKA_SASL_USERNAME && process.env.KAFKA_SASL_PASSWORD
      ? {
          mechanism: 'plain' as const,
          username: process.env.KAFKA_SASL_USERNAME,
          password: process.env.KAFKA_SASL_PASSWORD,
        }
      : undefined,
}));
