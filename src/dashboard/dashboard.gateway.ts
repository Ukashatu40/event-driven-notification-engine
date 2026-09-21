// src/dashboard/dashboard.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import { PrometheusService } from '../health/prometheus/prometheus.service';
import { WsJwtGuard } from './ws-jwt.guard';
// import { WsJwtGuard } from './ws-jwt.guard';

export interface NotificationStateEvent {
  notificationId: string;
  userId: string;
  eventType: string;
  channel: string;
  fromStatus: string | null;
  toStatus: string;
  timestamp: string;
}

/**
 * Real-time dashboard gateway.
 *
 * Two subscription modes:
 * - Admin/ops clients subscribe to the firehose (all notifications) for
 *   monitoring dashboards — requires JWT with admin role.
 * - Individual users can subscribe to their own notification stream only
 *   (room scoped to their userId) for an in-app live notification feed.
 *
 * This is intentionally kept separate from the in-app delivery provider
 * (websocket.provider.ts) which pushes actual notification content.
 * This gateway pushes *state machine transitions* for observability.
 */
@Injectable()
@WebSocketGateway({
  // Only the configured front-end origins — never '*': this stream carries user ids.
  cors: {
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
  },
  namespace: '/dashboard',
})
export class DashboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DashboardGateway.name);
  private readonly enabled: boolean;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly prometheus: PrometheusService,
    private readonly wsGuard: WsJwtGuard,
  ) {
    this.enabled =
      this.configService.get<boolean>('app.features.websocketDashboard') ??
      false;
  }

  handleConnection(client: Socket): void {
    if (!this.enabled) {
      client.disconnect(true);
      return;
    }

    // Guards do not run for connection events, so authenticate here. An
    // anonymous or wrongly-privileged socket is dropped before it can join any
    // room, i.e. before it can receive a single event.
    if (!this.wsGuard.isAuthorized(client.handshake?.auth?.['token'])) {
      this.logger.warn(
        `Rejected unauthenticated dashboard client ${client.id}`,
      );
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
      return;
    }

    this.prometheus.activeWebSocketConnections.inc();
    this.logger.log(`Dashboard client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.prometheus.activeWebSocketConnections.dec();
    this.logger.log(`Dashboard client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:firehose')
  handleFirehoseSubscribe(@ConnectedSocket() client: Socket): void {
    void client.join('firehose');
    client.emit('subscribed', { channel: 'firehose' });
  }

  @SubscribeMessage('subscribe:user')
  handleUserSubscribe(
    @MessageBody() data: { userId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    void client.join(`user:${data.userId}`);
    client.emit('subscribed', { channel: `user:${data.userId}` });
  }

  /**
   * Broadcasts a state transition to both the firehose and the
   * specific user's room. Called by NotificationStateService on every
   * transition — fire-and-forget, never blocks the state write.
   */
  broadcastStateChange(event: NotificationStateEvent): void {
    if (!this.enabled) return;

    this.server.to('firehose').emit('notification:state', event);
    this.server.to(`user:${event.userId}`).emit('notification:state', event);
  }

  /**
   * Broadcasts aggregate delivery stats every interval — used by the
   * dashboard's live counters (sent/delivered/failed per minute).
   */
  broadcastStats(stats: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.server.to('firehose').emit('stats:update', stats);
  }
}
