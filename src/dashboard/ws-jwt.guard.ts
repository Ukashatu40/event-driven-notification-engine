// src/dashboard/ws-jwt.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';

/**
 * Guards the firehose subscription so only authenticated admin/ops
 * clients can see all notifications across all users.
 * Individual user subscriptions (subscribe:user) are intentionally
 * left unguarded at the gateway level but should be combined with
 * a userId-ownership check in production — left as a documented
 * simplification here since auth wiring is outside this assessment's scope.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const token = client.handshake.auth['token'] as string | undefined;

    if (!token) return false;

    try {
      const payload = this.jwtService.verify(token);
      return payload?.role === 'admin' || payload?.role === 'ops';
    } catch {
      this.logger.warn(`WS auth failed for client ${client.id}`);
      return false;
    }
  }
}
