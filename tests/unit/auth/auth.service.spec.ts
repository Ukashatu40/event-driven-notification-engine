// tests/unit/auth/auth.service.spec.ts
import * as jwt from 'jsonwebtoken';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../../src/auth/auth.service';

const CFG: Record<string, string> = {
  'app.serviceKey': 'svc-key',
  'app.operatorKey': 'op-key',
  'app.adminKey': '',
  'app.jwt.secret': 'access-secret-'.padEnd(40, 'x'),
  'app.jwt.refreshSecret': 'refresh-secret-'.padEnd(40, 'y'),
  'app.jwt.refreshExpiry': '7d',
};

/** In-memory stand-in for the Redis commands the service uses. */
const fakeRedis = () => {
  const store = new Map<string, string>();
  const client = {
    set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    exists: jest.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    getdel: jest.fn(async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    }),
  };
  return { store, redis: { getClient: () => client } };
};

const build = () => {
  const { store, redis } = fakeRedis();
  const svc = new AuthService(
    { get: (k: string) => CFG[k] } as never,
    redis as never,
  );
  return { svc, store };
};

describe('AuthService.login — one credential per role', () => {
  it('issues tokens when the key matches the requested role', async () => {
    const { svc } = build();
    const t = await svc.login('svc-key', 'SERVICE');
    expect(t.token_type).toBe('Bearer');
    expect(t.expires_in).toBe(3600);
    expect(jwt.verify(t.access_token, CFG['app.jwt.secret'])).toMatchObject({
      role: 'SERVICE',
    });
  });

  it('NEVER lets the SERVICE key mint an ADMIN or OPERATOR token', async () => {
    const { svc } = build();
    await expect(svc.login('svc-key', 'ADMIN')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(svc.login('svc-key', 'OPERATOR')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the operator key only for OPERATOR', async () => {
    const { svc } = build();
    await expect(svc.login('op-key', 'OPERATOR')).resolves.toBeDefined();
    await expect(svc.login('op-key', 'SERVICE')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('a role with no configured key cannot log in — not even with an empty key', async () => {
    const { svc } = build();
    await expect(svc.login('', 'ADMIN')).rejects.toThrow(UnauthorizedException);
    await expect(svc.login('anything', 'ADMIN')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a key of a different length without throwing a comparison error', async () => {
    const { svc } = build();
    await expect(svc.login('x', 'SERVICE')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('access tokens live at most one hour (spec A10.1)', async () => {
    const { svc } = build();
    const t = await svc.login('svc-key', 'SERVICE');
    const { iat, exp } = jwt.decode(t.access_token) as {
      iat: number;
      exp: number;
    };
    expect(exp - iat).toBeLessThanOrEqual(3600);
  });
});

describe('AuthService.refresh — rotation with reuse detection', () => {
  it('returns a NEW pair and invalidates the old refresh token', async () => {
    const { svc } = build();
    const first = await svc.login('svc-key', 'SERVICE');
    const second = await svc.refresh(first.refresh_token);

    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).toBeDefined();
    // the rotated token works
    await expect(svc.refresh(second.refresh_token)).resolves.toBeDefined();
  });

  it('a refresh token can be used exactly once', async () => {
    const { svc } = build();
    const first = await svc.login('svc-key', 'SERVICE');
    await svc.refresh(first.refresh_token);
    await expect(svc.refresh(first.refresh_token)).rejects.toThrow(
      /already used/,
    );
  });

  it('REUSE revokes the whole family — the legitimate newer token stops working too', async () => {
    const { svc } = build();
    const first = await svc.login('svc-key', 'SERVICE');
    const second = await svc.refresh(first.refresh_token); // legit rotation
    await expect(svc.refresh(first.refresh_token)).rejects.toThrow(); // attacker replays the old one
    await expect(svc.refresh(second.refresh_token)).rejects.toThrow(/revoked/); // family is dead
  });

  it('tags access and refresh tokens with different types, so one can never stand in for the other', async () => {
    const { svc } = build();
    const pair = await svc.login('svc-key', 'SERVICE');
    expect((jwt.decode(pair.access_token) as { typ: string }).typ).toBe(
      'access',
    );
    expect((jwt.decode(pair.refresh_token) as { typ: string }).typ).toBe(
      'refresh',
    );
  });

  it('refuses an ACCESS token presented as a refresh token even if it were signed with the refresh secret', async () => {
    const { svc } = build();
    const imposter = jwt.sign(
      { sub: 'u', role: 'ADMIN', typ: 'access', jti: 'j', fam: 'f' },
      CFG['app.jwt.refreshSecret'],
    );
    await expect(svc.refresh(imposter)).rejects.toThrow(UnauthorizedException);
  });

  it('keeps role and subject across rotation', async () => {
    const { svc } = build();
    const first = await svc.login('op-key', 'OPERATOR');
    const second = await svc.refresh(first.refresh_token);
    const a = jwt.decode(first.access_token) as { sub: string; role: string };
    const b = jwt.decode(second.access_token) as { sub: string; role: string };
    expect(b).toMatchObject({ sub: a.sub, role: 'OPERATOR' });
  });

  it('rejects garbage, a token signed with the wrong secret, and an access token', async () => {
    const { svc } = build();
    const pair = await svc.login('svc-key', 'SERVICE');
    await expect(svc.refresh('garbage')).rejects.toThrow(UnauthorizedException);
    const forged = jwt.sign(
      { sub: 'u', role: 'ADMIN', jti: 'j', fam: 'f' },
      'attacker-secret',
    );
    await expect(svc.refresh(forged)).rejects.toThrow(UnauthorizedException);
    await expect(svc.refresh(pair.access_token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a validly-signed token that has no jti/family (pre-rotation tokens)', async () => {
    const { svc } = build();
    const legacy = jwt.sign(
      { sub: 'u', role: 'ADMIN' },
      CFG['app.jwt.refreshSecret'],
    );
    await expect(svc.refresh(legacy)).rejects.toThrow(UnauthorizedException);
  });
});
