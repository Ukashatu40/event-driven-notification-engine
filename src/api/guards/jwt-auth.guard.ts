// src/api/guards/jwt-auth.guard.ts
import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  role: 'ADMIN' | 'OPERATOR' | 'SERVICE';
  iat: number;
  exp: number;
}

@Injectable()
export class JwtAuthGuard {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing authorization token');
    }

    try {
      const secret = this.config.get<string>('app.jwt.secret') ?? '';
      const payload = jwt.verify(token, secret) as JwtPayload;
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
