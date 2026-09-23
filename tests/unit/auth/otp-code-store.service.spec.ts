// tests/unit/auth/otp-code-store.service.spec.ts
import { UnauthorizedException } from '@nestjs/common';
import { OtpCodeStore } from '../../../src/auth/otp-code-store.service';

/** In-memory stand-in for the Redis commands OtpCodeStore uses. */
const fakeRedis = () => {
  const store = new Map<string, { v: string; exp: number | null }>();
  const now = () => Date.now();
  const alive = (k: string) => {
    const e = store.get(k);
    if (!e) return undefined;
    if (e.exp !== null && e.exp < now()) {
      store.delete(k);
      return undefined;
    }
    return e;
  };
  const client = {
    set: jest.fn(async (k: string, v: string, ...rest: unknown[]) => {
      const exIdx = rest.indexOf('EX');
      const exp = exIdx >= 0 ? now() + Number(rest[exIdx + 1]) * 1000 : null;
      store.set(k, { v, exp });
      return 'OK';
    }),
    get: jest.fn(async (k: string) => alive(k)?.v ?? null),
    exists: jest.fn(async (k: string) => (alive(k) ? 1 : 0)),
    del: jest.fn(async (k: string) => void store.delete(k)),
    incr: jest.fn(async (k: string) => {
      const cur = Number(alive(k)?.v ?? '0') + 1;
      const existing = store.get(k);
      store.set(k, { v: String(cur), exp: existing?.exp ?? null });
      return cur;
    }),
    expire: jest.fn(async (k: string, seconds: number) => {
      const e = store.get(k);
      if (e) e.exp = now() + seconds * 1000;
    }),
    ttl: jest.fn(async (k: string) => {
      const e = alive(k);
      return e?.exp ? Math.ceil((e.exp - now()) / 1000) : -1;
    }),
  };
  return { store, redis: { getClient: () => client } };
};

function build() {
  const { redis, store } = fakeRedis();
  const codeStore = new OtpCodeStore(
    redis as never,
    { get: () => '5' } as never, // OTP_MAX_ATTEMPTS = 5
  );
  return { codeStore, store };
}

describe('OtpCodeStore', () => {
  it('round-trips: the code that was stored verifies, and returns the exact payload', async () => {
    const { codeStore } = build();
    await codeStore.store('k1', { userId: 'u-1' }, '123456', 300);

    const payload = await codeStore.verify<{ userId: string }>('k1', '123456');

    expect(payload).toEqual({ userId: 'u-1' });
  });

  it('is single-use: verifying the same code twice fails the second time', async () => {
    const { codeStore } = build();
    await codeStore.store('k1', { userId: 'u-1' }, '123456', 300);
    await codeStore.verify('k1', '123456');

    await expect(codeStore.verify('k1', '123456')).rejects.toThrow(/expired/);
  });

  it('rejects a wrong code without revealing anything about the stored payload', async () => {
    const { codeStore } = build();
    await codeStore.store('k1', { userId: 'u-1' }, '123456', 300);

    await expect(codeStore.verify('k1', '000000')).rejects.toThrow(
      'Incorrect code',
    );
  });

  it('invalidates the whole code after the max attempts — even the right code stops working', async () => {
    const { codeStore } = build();
    await codeStore.store('k1', { userId: 'u-1' }, '123456', 300);

    for (let i = 0; i < 4; i++) {
      await expect(codeStore.verify('k1', '000000')).rejects.toThrow(
        'Incorrect code',
      );
    }
    await expect(codeStore.verify('k1', '000000')).rejects.toThrow(
      /Too many incorrect attempts/,
    );
    await expect(codeStore.verify('k1', '123456')).rejects.toThrow(/expired/);
  });

  it('rejects an unknown or expired key', async () => {
    const { codeStore } = build();
    await expect(codeStore.verify('does-not-exist', '123456')).rejects.toThrow(
      /expired/,
    );
  });

  describe('checkRateLimit', () => {
    it('allows the first few requests, then rate-limits', async () => {
      const { codeStore } = build();
      for (let i = 0; i < 3; i++) {
        await codeStore.checkRateLimit(`cooldown-${i}`, 'rate-key', 0);
      }
      await expect(
        codeStore.checkRateLimit('cooldown-x', 'rate-key', 0),
      ).rejects.toThrow(/Too many codes/);
    });

    it('enforces the resend cooldown', async () => {
      const { codeStore } = build();
      await codeStore.checkRateLimit('cooldown', 'rate', 60);
      await expect(
        codeStore.checkRateLimit('cooldown', 'rate', 60),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('fails open when Redis itself errors (availability over strictness here)', async () => {
      const redis = {
        getClient: () => ({
          exists: jest.fn(async () => {
            throw new Error('connection refused');
          }),
        }),
      };
      const codeStore = new OtpCodeStore(
        redis as never,
        { get: () => '5' } as never,
      );
      await expect(
        codeStore.checkRateLimit('c', 'r', 60),
      ).resolves.toBeUndefined();
    });
  });
});
