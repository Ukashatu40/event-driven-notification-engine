// src/api/guards/jwt-auth.guard.ts
import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import * as jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export interface JwtPayload {
  typ?: string;
  sub: string;
  role: 'ADMIN' | 'OPERATOR' | 'SERVICE';
  iat: number;
  exp: number;
}

@Injectable()
export class JwtAuthGuard {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Allow routes decorated with @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing authorization token');
    }

    try {
      const secret = this.config.get<string>('app.jwt.secret') ?? '';
      const payload = jwt.verify(token, secret) as JwtPayload;
      // Only ACCESS tokens open the API. Defence in depth: even if the two
      // secrets were ever configured equal, a refresh token cannot be replayed
      // as an access token.
      if (payload.typ !== 'access') throw new Error('not an access token');
      (request as FastifyRequest & { user: JwtPayload }).user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: FastifyRequest): string | undefined {
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      return auth.substring(7);
    }
    return undefined;
  }
}
