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
      kafkaConfig.ssl = true;
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
