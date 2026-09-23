// tests/unit/auth/otp.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { OtpService } from '../../../src/auth/otp.service';

const CFG: Record<string, string> = {
  OTP_CODE_TTL_SECONDS: '300',
  OTP_RESEND_COOLDOWN_SECONDS: '60',
};

function build() {
  const prisma = { user: { findUnique: jest.fn() } };
  const pii = {
    phoneHash: jest.fn((p: string) => `phash:${p}`),
    emailHash: jest.fn((e: string) => `ehash:${e.toLowerCase()}`),
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

  const svc = new OtpService(
    prisma as never,
    pii as never,
    { get: (k: string) => CFG[k] } as never,
    codeStore as never,
    delivery as never,
    authService as never,
  );

  return { svc, prisma, codeStore, delivery, authService };
}

describe('OtpService.request', () => {
  it('rejects neither identifier, and both at once', async () => {
    const { svc } = build();
    await expect(svc.request({})).rejects.toThrow(BadRequestException);
    await expect(
      svc.request({ phone: '+919876543210', email: 'a@b.com' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a non-E.164 phone number', async () => {
    const { svc } = build();
    await expect(svc.request({ phone: '08031234567' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('sends a code and stores the userId when the identifier is registered', async () => {
    const { svc, prisma, delivery, codeStore } = build();
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', market: 'IN' });

    await svc.request({ phone: '+919876543210' });

    expect(delivery.sendSms).toHaveBeenCalledWith(
      '+919876543210',
      'IN',
      expect.any(String),
      300,
    );
    expect(codeStore.store).toHaveBeenCalledWith(
      expect.stringContaining('auth:otp:req:'),
      { userId: 'u-1' },
      expect.any(String),
      300,
    );
  });

  it('sends NOTHING for an unregistered identifier, but returns the same response shape', async () => {
    const { svc, prisma, delivery, codeStore } = build();
    prisma.user.findUnique.mockResolvedValue(null);

    const result = await svc.request({ email: 'nobody@example.com' });

    expect(result).toEqual({
      requestId: expect.any(String),
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    });
    expect(delivery.sendSms).not.toHaveBeenCalled();
    expect(delivery.sendEmail).not.toHaveBeenCalled();
    expect(codeStore.store).toHaveBeenCalledWith(
      expect.any(String),
      { userId: null },
      expect.any(String),
      300,
    );
  });
});

describe('OtpService.verify', () => {
  it('issues a USER token for a registered identifier', async () => {
    const { svc, codeStore, authService } = build();
    codeStore.verify.mockResolvedValue({ userId: 'u-42' });

    const tokens = await svc.verify('req-1', '123456');

    expect(authService.issueForUser).toHaveBeenCalledWith('u-42');
    expect(tokens.access_token).toBe('t-u-42');
  });

  it('fails the SAME way for a correct code against an unregistered identifier as for a wrong code (no enumeration)', async () => {
    const { svc, codeStore, authService } = build();
    codeStore.verify.mockResolvedValue({ userId: null });

    await expect(svc.verify('req-1', '123456')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authService.issueForUser).not.toHaveBeenCalled();
  });

  it('propagates whatever OtpCodeStore throws for a wrong/expired code, unchanged', async () => {
    const { svc, codeStore } = build();
    codeStore.verify.mockRejectedValue(
      new UnauthorizedException('Incorrect code'),
    );

    await expect(svc.verify('req-1', '000000')).rejects.toThrow(
      'Incorrect code',
    );
  });
});
