// src/config/rabbitmq.config.ts

import { registerAs } from '@nestjs/config';

export const rabbitmqConfig = registerAs('rabbitmq', (): any => ({
  url: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
  exchange: process.env.RABBITMQ_EXCHANGE ?? 'notifications',
  dlx: process.env.RABBITMQ_DLX ?? 'notifications.dlx',

  // Queues — each channel gets its own queue with DLQ
  queues: {
    sms: {
      name: 'notifications.sms',
      dlq: 'notifications.sms.dlq',
      priority: 10, // RabbitMQ max priority level
      prefetch: 50, // consumers pull 50 at a time
    },
    email: {
      name: 'notifications.email',
      dlq: 'notifications.email.dlq',
      priority: 10,
      prefetch: 100,
    },
    push: {
      name: 'notifications.push',
      dlq: 'notifications.push.dlq',
      priority: 10,
      prefetch: 200,
    },
    whatsapp: {
      name: 'notifications.whatsapp',
      dlq: 'notifications.whatsapp.dlq',
      priority: 10,
      prefetch: 50,
    },
    inApp: {
      name: 'notifications.in_app',
      dlq: 'notifications.in_app.dlq',
      priority: 10,
      prefetch: 500,
    },
    retry: {
      name: 'notifications.retry',
      dlq: 'notifications.retry.dlq',
      priority: 5,
      prefetch: 20,
    },
  },

  // Routing keys map event priority to RabbitMQ message priority (1-10)
  // RabbitMQ priority 10 = highest, 1 = lowest
  priorityMap: {
    1: 10, // CRITICAL events → priority 10 in RabbitMQ queue
    2: 7, // HIGH → 7
    3: 5, // MEDIUM → 5
    5: 2, // LOW → 2
  } as Record<number, number>,

  // Message TTL per priority in milliseconds
  // CRITICAL messages expire after 5 min if unprocessed (fail fast, escalate)
  messageTtlMs: {
    1: 300_000, // CRITICAL: 5 minutes
    2: 1_800_000, // HIGH: 30 minutes
    3: 86_400_000, // MEDIUM: 24 hours
    5: 604_800_000, // LOW: 7 days
  } as Record<number, number>,
}));
