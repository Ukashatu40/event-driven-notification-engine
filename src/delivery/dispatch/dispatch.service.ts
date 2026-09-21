// src/delivery/dispatch/dispatch.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RabbitMQService } from '../../infrastructure/rabbitmq/rabbitmq.service';
import { PiiService } from '../../shared/pii/pii.service';
import { PreparedNotification } from '../providers/delivery-provider.interface';

interface RecipientSource {
  id: string;
  phone: string;
  email: string;
}

/** Shape written to notifications.rendered_content by the template engine. */
interface StoredContent {
  subject?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

/**
 * Single place that puts a prepared notification onto its channel queue.
 *
 * Used by the engine (first publish) and the retry worker (republish), so the
 * queue topology, priority mapping and recipient resolution live in one spot.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly pii: PiiService,
  ) {}

  /**
   * Resolves the channel-specific address for a user, decrypting the stored
   * phone/email. Call it as late as possible — the plaintext address must not
   * be persisted or queued (see publish()).
   */
  resolveRecipient(user: RecipientSource, channel: string): string {
    switch (channel) {
      case 'sms':
      case 'whatsapp':
        return this.pii.decrypt(user.phone);
      case 'email':
        return this.pii.decrypt(user.email);
      default:
        // push tokens are looked up by the FCM provider from the user id;
        // in-app is addressed by user id (socket room).
        return user.id;
    }
  }

  /**
   * Loads the user and resolves their address for a channel plus their market
   * (worker side) — the market selects the SMS provider chain.
   */
  async lookupContact(
    userId: string,
    channel: string,
  ): Promise<{ recipient: string; market: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, email: true, market: true },
    });
    if (!user) {
      throw new Error(`User ${userId} not found while resolving recipient`);
    }
    return {
      recipient: this.resolveRecipient(user, channel),
      market: user.market,
    };
  }

  async lookupRecipient(userId: string, channel: string): Promise<string> {
    return (await this.lookupContact(userId, channel)).recipient;
  }

  /**
   * Queues a notification. The broker persists messages to disk, so the real
   * phone/email is NOT put on the queue: the message carries a user reference
   * and the delivery worker resolves the address right before the provider
   * call (DeliveryService.process → lookupRecipient).
   */
  async publish(notification: PreparedNotification): Promise<void> {
    await this.rabbitmq.publish(
      `notifications.${notification.channel}`,
      { ...notification, recipient: `user:${notification.userId}` },
      {
        priority: this.mapPriority(notification.priority),
        correlationId: notification.correlationId,
        persistent: true,
      },
    );
  }

  /**
   * Republishes an already-rendered notification (retry / deferred release).
   * Returns false when the record cannot be dispatched.
   */
  async publishStored(notificationId: string): Promise<boolean> {
    const n = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!n || !n.renderedContent) {
      this.logger.error(
        `Cannot republish ${notificationId}: ${n ? 'no rendered content' : 'not found'}`,
      );
      return false;
    }

    const content = n.renderedContent as unknown as StoredContent;

    await this.publish({
      notificationId: n.id,
      userId: n.userId,
      channel: n.channel,
      recipient: `user:${n.userId}`,
      subject: content.subject,
      title: content.title,
      body: content.body ?? '',
      data: content.data,
      priority: n.priority,
      correlationId: n.correlationId,
    });

    return true;
  }

  private mapPriority(priority: number): number {
    const map =
      this.config.get<Record<number, number>>('rabbitmq.priorityMap') ?? {};
    return map[priority] ?? 5;
  }
}
