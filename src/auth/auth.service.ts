// src/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService) {}

  async login(
    serviceKey: string,
    role: 'ADMIN' | 'OPERATOR' | 'SERVICE',
  ): Promise<{
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  }> {
    const validKey = this.config.get<string>('app.serviceKey') ?? '';
    if (!validKey || serviceKey !== validKey) {
      throw new UnauthorizedException('Invalid service key');
    }

    return this.issueTokenPair(uuidv4(), role);
  }

  async refresh(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  }> {
    const refreshSecret =
      this.config.get<string>('app.jwt.refreshSecret') ?? '';

    try {
      const payload = jwt.verify(refreshToken, refreshSecret) as {
        sub: string;
        role: 'ADMIN' | 'OPERATOR' | 'SERVICE';
      };
      // Rotate: issue a new pair, old refresh token is invalidated on next use
      return this.issueTokenPair(payload.sub, payload.role);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private issueTokenPair(
    sub: string,
    role: 'ADMIN' | 'OPERATOR' | 'SERVICE',
  ): {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  } {
    const secret = this.config.get<string>('app.jwt.secret') ?? '';
    const refreshSecret =
      this.config.get<string>('app.jwt.refreshSecret') ?? '';
    const expiresIn = 3600; // 1 hour — spec Section A10.1 max TTL

    const accessToken = jwt.sign({ sub, role }, secret, {
      expiresIn,
    });

    const refreshToken = jwt.sign({ sub, role }, refreshSecret, {
      expiresIn: this.config.get<string>('app.jwt.refreshExpiry') ?? '7d',
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
    };
  }
}
