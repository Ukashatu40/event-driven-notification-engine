// src/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from '../infrastructure/redis/redis.service';
import { REDIS_KEYS } from '../shared/constants/redis-keys';

export type Role = 'ADMIN' | 'OPERATOR' | 'SERVICE' | 'USER';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

interface RefreshClaims {
  typ?: string;
  sub: string;
  role: Role;
  jti: string;
  fam: string;
}

const ACCESS_TTL_SECONDS = 3600; // 1 hour — spec A10.1 maximum

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Each role has its OWN credential. The requested role is only granted if the
   * key presented is the key configured for that role — otherwise anyone
   * holding the service key could simply ask for `ADMIN`.
   */
  async login(key: string, role: Exclude<Role, 'USER'>): Promise<TokenPair> {
    const configKey = {
      SERVICE: 'app.serviceKey',
      OPERATOR: 'app.operatorKey',
      ADMIN: 'app.adminKey',
    }[role];
    const expected = this.config.get<string>(configKey) ?? '';

    if (!expected || !safeEqual(key, expected)) {
      throw new UnauthorizedException('Invalid credentials for this role');
    }

    return this.issue(uuidv4(), role, uuidv4());
  }

  /**
   * Refresh-token ROTATION with reuse detection.
   *
   * Every refresh token is single-use: its `jti` is recorded in Redis when
   * issued and consumed (atomically, GETDEL) when redeemed. Presenting a token
   * whose jti is gone means it was already used (or the session was revoked) —
   * the whole token family is revoked, so a stolen token that is replayed
   * logs the legitimate user out too, and the thief gets nothing.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const secret = this.config.get<string>('app.jwt.refreshSecret') ?? '';

    let claims: RefreshClaims;
    try {
      claims = jwt.verify(refreshToken, secret) as RefreshClaims;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    // A refresh token is only ever a refresh token (and vice versa: see JwtAuthGuard).
    if (claims.typ !== 'refresh' || !claims.jti || !claims.fam) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const client = this.redis.getClient();

    if (await client.exists(REDIS_KEYS.authRevokedFamily(claims.fam))) {
      throw new UnauthorizedException('Session revoked — please log in again');
    }

    const consumed = await client.getdel(REDIS_KEYS.authRefresh(claims.jti));
    if (!consumed) {
      // Valid signature but already redeemed: treat as theft.
      const ttl = Math.max(
        1,
        (claims as unknown as { exp: number }).exp -
          Math.floor(Date.now() / 1000),
      );
      await client.set(
        REDIS_KEYS.authRevokedFamily(claims.fam),
        '1',
        'EX',
        ttl,
      );
      throw new UnauthorizedException(
        'Refresh token already used — session revoked',
      );
    }

    return this.issue(claims.sub, claims.role, claims.fam);
  }

  /**
   * Issues a fresh token pair for an end user who has just verified an OTP
   * (see OtpService). A new random family, exactly like a fresh login — there
   * is no static credential for the USER role, so this is its only entry point.
   */
  async issueForUser(userId: string): Promise<TokenPair> {
    return this.issue(userId, 'USER', uuidv4());
  }

  private async issue(
    sub: string,
    role: Role,
    family: string,
  ): Promise<TokenPair> {
    const secret = this.config.get<string>('app.jwt.secret') ?? '';
    const refreshSecret =
      this.config.get<string>('app.jwt.refreshSecret') ?? '';
    const jti = uuidv4();

    const accessToken = jwt.sign({ sub, role, typ: 'access' }, secret, {
      expiresIn: ACCESS_TTL_SECONDS,
    });
    const refreshToken = jwt.sign(
      { sub, role, typ: 'refresh', jti, fam: family },
      refreshSecret,
      {
        expiresIn: this.config.get<string>('app.jwt.refreshExpiry') ?? '7d',
      },
    );

    const { exp } = jwt.decode(refreshToken) as { exp: number };
    await this.redis
      .getClient()
      .set(
        REDIS_KEYS.authRefresh(jti),
        family,
        'EX',
        Math.max(1, exp - Math.floor(Date.now() / 1000)),
      );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
    };
  }
}
