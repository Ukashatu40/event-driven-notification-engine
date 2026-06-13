// src/infrastructure/rabbitmq/rabbitmq.service.ts
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';

export interface RabbitMQPublishOptions {
  priority?: number;
  expiration?: number;
  correlationId?: string;
  persistent?: boolean;
}

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
    await this.setupTopology();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      this.logger.log('RabbitMQ disconnected');
    } catch (err) {
      this.logger.error(
        `Error during RabbitMQ disconnect: ${(err as Error).message}`,
      );
    }
  }

  private async connect(): Promise<void> {
    const url = this.configService.get<string>('rabbitmq.url') ?? '';

    this.connection = await amqplib.connect(url);
    this.channel = await this.connection.createChannel();

    this.connection.on('error', (err: Error) => {
      this.logger.error(`RabbitMQ connection error: ${err.message}`);
    });

    this.connection.on('close', () => {
      this.logger.warn('RabbitMQ connection closed — reconnecting in 5s');
      setTimeout(() => void this.connect(), 5_000);
    });

    this.logger.log('RabbitMQ connected');
  }

  private async setupTopology(): Promise<void> {
    if (!this.channel) return;

    const exchange =
      this.configService.get<string>('rabbitmq.exchange') ?? 'notifications';
    const dlx =
      this.configService.get<string>('rabbitmq.dlx') ?? 'notifications.dlx';

    const queues =
      this.configService.get<
        Record<
          string,
          {
            name: string;
            dlq: string;
            priority: number;
            prefetch: number;
          }
        >
      >('rabbitmq.queues') ?? {};

    // 1. Assert main exchange
    await this.channel.assertExchange(exchange, 'topic', {
      durable: true,
    });

    // 2. Assert dead letter exchange
    await this.channel.assertExchange(dlx, 'fanout', {
      durable: true,
    });

    for (const [, config] of Object.entries(queues)) {
      // 3. Assert DLQ first — must exist before main queue references it
      await this.channel.assertQueue(config.dlq, {
        durable: true,
      });

      // 4. Bind DLQ to DLX
      await this.channel.bindQueue(config.dlq, dlx, '');

      // 5. Assert main queue with dead letter config
      await this.channel.assertQueue(config.name, {
        durable: true,
        arguments: {
          'x-max-priority': config.priority,
          'x-dead-letter-exchange': dlx,
        },
      });

      // 6. Bind main queue to main exchange
      const channelName = config.name.replace('notifications.', '');
      await this.channel.bindQueue(
        config.name,
        exchange,
        `notifications.${channelName}`,
      );

      this.logger.log(`Queue ready: ${config.name}`);
    }
  }

  async publish(
    routingKey: string,
    message: Record<string, unknown>,
    options: RabbitMQPublishOptions = {},
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    const exchange =
      this.configService.get<string>('rabbitmq.exchange') ?? 'notifications';
    const content = Buffer.from(JSON.stringify(message));

    const publishOptions: amqplib.Options.Publish = {
      persistent: options.persistent ?? true,
      priority: options.priority ?? 1,
      correlationId: options.correlationId,
      contentType: 'application/json',
      timestamp: Date.now(),
    };

    if (options.expiration) {
      publishOptions.expiration = options.expiration.toString();
    }

    this.channel.publish(exchange, routingKey, content, publishOptions);
  }

  async consume(
    queueName: string,
    prefetch: number,
    handler: (
      message: Record<string, unknown>,
      ack: () => void,
      nack: (requeue?: boolean) => void,
    ) => Promise<void>,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    await this.channel.prefetch(prefetch);

    await this.channel.consume(queueName, async (msg) => {
      if (!msg) return;

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(msg.content.toString());
      } catch {
        this.logger.error(`Failed to parse RabbitMQ message from ${queueName}`);
        this.channel?.nack(msg, false, false);
        return;
      }

      const ack = (): void => {
        this.channel?.ack(msg);
      };
      const nack = (requeue = false): void => {
        this.channel?.nack(msg, false, requeue);
      };

      await handler(parsed, ack, nack);
    });

    this.logger.log(
      `Consuming from queue: ${queueName} (prefetch: ${prefetch})`,
    );
  }

  async ping(): Promise<boolean> {
    try {
      return this.channel !== null && this.connection !== null;
    } catch {
      return false;
    }
  }
}
