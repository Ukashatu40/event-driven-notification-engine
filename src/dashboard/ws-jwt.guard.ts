// src/dashboard/ws-jwt.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';

/** Roles allowed to watch the live dashboard: the read-only ones and full access. */
const DASHBOARD_ROLES = ['ADMIN', 'OPERATOR'];

/**
 * Authorises access to the live dashboard (spec Section B3.4 WebSocket bonus).
 *
 * The dashboard streams every notification state change — user ids, event types,
 * channels — so it must never be open to anonymous sockets. Note that Nest
 * guards do NOT run for a gateway's `handleConnection`, so the gateway calls
 * `isAuthorized()` itself when a client connects; `canActivate` covers
 * individual `@SubscribeMessage` handlers.
 *
 * Token: `io(url, { auth: { token: "<access JWT>" } })`, the same JWT the REST
 * API uses. Only ADMIN and OPERATOR roles are accepted.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  isAuthorized(token: unknown): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    try {
      const payload = this.jwtService.verify<{ role?: string; typ?: string }>(
        token,
      );
      return (
        payload?.typ === 'access' &&
        DASHBOARD_ROLES.includes(payload?.role ?? '')
      );
    } catch {
      return false;
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const ok = this.isAuthorized(client.handshake?.auth?.['token']);
    if (!ok) this.logger.warn(`WS auth failed for client ${client.id}`);
    return ok;
  }
}
