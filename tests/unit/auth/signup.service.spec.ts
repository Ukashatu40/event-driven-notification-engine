// tests/unit/auth/signup.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { SignupService } from '../../../src/auth/signup.service';

const CFG: Record<string, string> = {
  OTP_CODE_TTL_SECONDS: '300',
  OTP_RESEND_COOLDOWN_SECONDS: '60',
};

function build() {
  const prisma = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    userPreference: { createMany: jest.fn() },
  };
  const pii = {
    phoneHash: jest.fn((p: string) => `phash:${p}`),
    emailHash: jest.fn((e: string) => `ehash:${e.toLowerCase()}`),
    encrypt: jest.fn((v: string) => `enc:${v}`),
  };
  const codeStore = {
    checkRateLimit: jest.fn(async () => undefined),
    store: jest.fn(async () => undefined),
    verify: jest.fn(),
  };
  const delivery = {
    sendSms: jest.fn(async () => undefined),
    sendEmail: jest.fn(async () => undefined),
  };
  const authService = {
    issueForUser: jest.fn(async (userId: string) => ({
      access_token: `t-${userId}`,
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    })),
  };

  const svc = new SignupService(
    prisma as never,
    pii as never,
    { get: (k: string) => CFG[k] } as never,
    codeStore as never,
    delivery as never,
    authService as never,
  );

  return { svc, prisma, pii, codeStore, delivery, authService };
}

describe('SignupService.request', () => {
  it('rejects a missing or too-short name', async () => {
    const { svc } = build();
    await expect(svc.request({ email: 'a@b.com' } as never)).rejects.toThrow(
      BadRequestException,
    );
    await expect(svc.request({ name: 'A', email: 'a@b.com' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects neither identifier, and both at once', async () => {
    const { svc } = build();
    await expect(svc.request({ name: 'Ada Lovelace' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      svc.request({
        name: 'Ada Lovelace',
        phone: '+2348031234567',
        email: 'a@b.com',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses to sign up an already-registered identifier — UNLIKE login, this says so plainly', async () => {
    const { svc, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ id: 'existing-user' });

    await expect(
      svc.request({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    ).rejects.toThrow(ConflictException);
  });

  it('sends a real code and stores the pending signup for a genuinely new identifier', async () => {
    const { svc, prisma, delivery, codeStore } = build();
    prisma.user.findUnique.mockResolvedValue(null);

    await svc.request({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      market: 'ng',
    });

    expect(delivery.sendEmail).toHaveBeenCalledWith(
      'ada@example.com',
      expect.any(String),
      300,
    );
    expect(codeStore.store).toHaveBeenCalledWith(
      expect.stringContaining('auth:signup:req:'),
      expect.objectContaining({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        market: 'NG',
      }),
      expect.any(String),
      300,
    );
  });

  it('defaults market/language when not given', async () => {
    const { svc, prisma, codeStore } = build();
    prisma.user.findUnique.mockResolvedValue(null);

    await svc.request({ name: 'Ada Lovelace', email: 'ada@example.com' });

    expect(codeStore.store).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ market: 'IN', language: 'EN' }),
      expect.any(String),
      300,
    );
  });
});

describe('SignupService.verify', () => {
  it('creates the user, seeds 25 default preference rows, and returns a token', async () => {
    const { svc, prisma, codeStore, authService } = build();
    codeStore.verify.mockResolvedValue({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: null,
      market: 'IN',
      language: 'EN',
    });
    prisma.user.findUnique.mockResolvedValue(null); // no race with a concurrent signup
    prisma.user.create.mockResolvedValue({ id: 'new-user-1' });

    const tokens = await svc.verify('req-1', '123456');

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Ada Lovelace',
          market: 'IN',
          language: 'EN',
        }),
      }),
    );
    expect(prisma.userPreference.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ userId: 'new-user-1' }),
      ]),
    });
    expect(prisma.userPreference.createMany.mock.calls[0][0].data).toHaveLength(
      25,
    );
    expect(authService.issueForUser).toHaveBeenCalledWith('new-user-1');
    expect(tokens.access_token).toBe('t-new-user-1');
  });

  it('sets the timezone from the chosen market, not the column default', async () => {
    // The Prisma column default is Asia/Kolkata (IN) — without this wiring, a
    // Nigerian sign-up would silently get India's quiet-hours/digest timezone.
    const { svc, prisma, codeStore } = build();
    codeStore.verify.mockResolvedValue({
      name: 'Chinedu Okafor',
      email: 'chinedu@example.com',
      phone: null,
      market: 'NG',
      language: 'EN',
    });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'new-user-2' });

    await svc.verify('req-1', '123456');

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          market: 'NG',
          timezone: 'Africa/Lagos',
        }),
      }),
    );
  });

  it('refuses if the identifier was registered by someone else between request() and verify()', async () => {
    const { svc, prisma, codeStore } = build();
    codeStore.verify.mockResolvedValue({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: null,
      market: 'IN',
      language: 'EN',
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'someone-else' });

    await expect(svc.verify('req-1', '123456')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('propagates whatever OtpCodeStore throws for a wrong/expired code, unchanged', async () => {
    const { svc, codeStore } = build();
    codeStore.verify.mockRejectedValue(new Error('Incorrect code'));

    await expect(svc.verify('req-1', '000000')).rejects.toThrow(
      'Incorrect code',
    );
  });
});
