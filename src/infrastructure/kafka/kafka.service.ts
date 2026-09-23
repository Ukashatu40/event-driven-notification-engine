// src/infrastructure/kafka/kafka.service.ts
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Kafka,
  Producer,
  Consumer,
  Admin,
  Message,
  RecordMetadata,
  KafkaConfig,
  ProducerConfig,
} from 'kafkajs';

/**
 * Accepts KAFKA_SSL_CA as raw PEM (real newlines), PEM with literal "\n"
 * escapes (some env-var UIs flatten real newlines on paste), or — the
 * recommended form — base64 of the whole PEM file. Base64 is the robust
 * choice: it's genuinely one line, so there is nothing left for a web form's
 * text input to mangle, unlike a multi-line paste (a single-line `<input>`
 * commonly collapses newlines into nothing, not even a literal "\n", which
 * left the previous "\n"-only fix unable to help — the resulting jammed-
 * together string isn't valid PEM, and kafkajs fails exactly as if no CA
 * had been given at all: the same "self-signed certificate" error).
 */
export function normalizeCaCert(raw: string): string {
  const withRealNewlines = raw.replace(/\\n/g, '\n');
  if (withRealNewlines.includes('-----BEGIN CERTIFICATE-----')) {
    return withRealNewlines;
  }
  const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8');
  return decoded.includes('-----BEGIN CERTIFICATE-----')
    ? decoded
    : withRealNewlines;
}

export interface KafkaMessage {
  key?: string;
  value: Record<string, unknown>;
  headers?: Record<string, string>;
  partition?: number;
}

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka: Kafka;
  private producer: Producer;
  private admin: Admin;
  private consumers: Map<string, Consumer> = new Map();

  constructor(private readonly configService: ConfigService) {
    const kafkaConfig: KafkaConfig = {
      clientId:
        this.configService.get<string>('kafka.clientId') ??
        'notification-engine',
      brokers: this.configService.get<string[]>('kafka.brokers') ?? [
        'localhost:9092',
      ],
      retry: {
        initialRetryTime: 100,
        retries: 10,
        factor: 2,
        maxRetryTime: 30_000,
      },
    };

    const ssl = this.configService.get<boolean>('kafka.ssl');
    if (ssl) {
      const sslCa = this.configService.get<string>('kafka.sslCa');
      // A provider-issued CA (Aiven, etc.) beats plain `ssl: true`, which
      // only trusts Node's public root store and rejects a broker cert
      // signed by the provider's own CA. See normalizeCaCert() for why the
      // raw value can be PEM, "\n"-escaped PEM, or (recommended) base64.
      kafkaConfig.ssl = sslCa
        ? { ca: [normalizeCaCert(sslCa)], rejectUnauthorized: true }
        : true;
    }

    const sasl = this.configService.get('kafka.sasl');
    if (sasl) {
      kafkaConfig.sasl = sasl;
    }

    this.kafka = new Kafka(kafkaConfig);

    const producerConfig: ProducerConfig = {
      idempotent: true,
      maxInFlightRequests: 5,
      transactionTimeout: 30_000,
    };

    this.producer = this.kafka.producer(producerConfig);
    this.admin = this.kafka.admin();
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    await this.admin.connect();
    await this.ensureTopicsExist();
    this.logger.log('Kafka producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    await this.admin.disconnect();
    for (const [groupId, consumer] of this.consumers) {
      await consumer.disconnect();
      this.logger.log(`Kafka consumer ${groupId} disconnected`);
    }
  }

  // ── Topic provisioning ────────────────────────────────────────────

  private async ensureTopicsExist(): Promise<void> {
    const topics =
      this.configService.get<Record<string, string>>('kafka.topics');
    if (!topics) return;

    const topicList = Object.values(topics).map((topic) => ({
      topic,
      numPartitions: topic.includes('critical') ? 3 : 6,
      replicationFactor: 1,
      configEntries: [
        {
          name: 'retention.ms',
          value: topic.includes('dlq') ? '2592000000' : '604800000',
        },
        { name: 'compression.type', value: 'gzip' },
      ],
    }));

    const existingTopics = await this.admin.listTopics();

    const topicsToCreate = topicList.filter(
      (t) => !existingTopics.includes(t.topic),
    );

    if (topicsToCreate.length > 0) {
      await this.admin.createTopics({ topics: topicsToCreate });
      this.logger.log(
        `Created topics: ${topicsToCreate.map((t) => t.topic).join(', ')}`,
      );
    }
  }

  // ── Producer ──────────────────────────────────────────────────────

  async publish(
    topic: string,
    message: KafkaMessage,
    correlationId?: string,
  ): Promise<RecordMetadata[]> {
    const kafkaMessage: Message = {
      key: message.key ? Buffer.from(message.key) : null,
      value: Buffer.from(JSON.stringify(message.value)),
      headers: {
        'correlation-id': correlationId ?? '',
        'content-type': 'application/json',
        timestamp: Date.now().toString(),
        ...message.headers,
      },
    };

    const result = await this.producer.send({
      topic,
      messages: [kafkaMessage],
    });

    return result;
  }

  async publishBatch(
    topic: string,
    messages: KafkaMessage[],
  ): Promise<RecordMetadata[]> {
    const kafkaMessages: Message[] = messages.map((msg) => ({
      key: msg.key ? Buffer.from(msg.key) : null,
      value: Buffer.from(JSON.stringify(msg.value)),
      headers: {
        'content-type': 'application/json',
        timestamp: Date.now().toString(),
        ...msg.headers,
      },
    }));

    return this.producer.send({ topic, messages: kafkaMessages });
  }

  // ── Consumer ─────────────────────────────────────────────────────

  async subscribe(
    groupId: string,
    topics: string[],
    handler: (
      topic: string,
      partition: number,
      message: Record<string, unknown>,
      headers: Record<string, string>,
    ) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId,
      sessionTimeout:
        this.configService.get<number>('kafka.consumer.sessionTimeoutMs') ??
        45_000,
      heartbeatInterval:
        this.configService.get<number>('kafka.consumer.heartbeatIntervalMs') ??
        15_000,
      maxInFlightRequests: 100,
    });

    await consumer.connect();
    this.consumers.set(groupId, consumer);

    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
      autoCommit: false, // manual offset — at-least-once delivery guarantee
      eachMessage: async ({ topic, partition, message, heartbeat }) => {
        const headers: Record<string, string> = {};
        if (message.headers) {
          for (const [key, val] of Object.entries(message.headers)) {
            headers[key] = val?.toString() ?? '';
          }
        }

        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(message.value?.toString() ?? '{}');
        } catch {
          this.logger.error(`Failed to parse Kafka message on topic ${topic}`);
          return;
        }

        try {
          await handler(topic, partition, parsed, headers);
          await heartbeat(); // prevent session timeout during slow processing
          await consumer.commitOffsets([
            {
              topic,
              partition,
              offset: (BigInt(message.offset) + 1n).toString(),
            },
          ]);
        } catch (err) {
          this.logger.error(
            `Error processing message on ${topic}:${partition}: ${(err as Error).message}`,
          );
          // Do NOT commit — message will be re-delivered
        }
      },
    });

    this.logger.log(`Consumer ${groupId} subscribed to: ${topics.join(', ')}`);
  }

  /**
   * Consumer lag per partition: (log-end offset) − (group's committed offset).
   * A partition the group has never committed on counts its whole log as lag.
   */
  async getConsumerLag(
    groupId: string,
    topic: string,
  ): Promise<Array<{ partition: number; lag: number }>> {
    const [end, committed] = await Promise.all([
      this.admin.fetchTopicOffsets(topic),
      this.admin.fetchOffsets({ groupId, topics: [topic] }),
    ]);
    const committedBy = new Map(
      (committed[0]?.partitions ?? []).map((p) => [
        p.partition,
        Number(p.offset),
      ]),
    );

    return end.map((p) => {
      const done = committedBy.get(p.partition);
      // offset -1 means "no commit yet"
      const consumed = done === undefined || done < 0 ? Number(p.low) : done;
      return {
        partition: p.partition,
        lag: Math.max(0, Number(p.offset) - consumed),
      };
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.admin.listTopics();
      return true;
    } catch {
      return false;
    }
  }
}
