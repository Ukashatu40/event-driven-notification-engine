// tests/unit/notifications/notification-preview.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { NotificationPreviewService } from '../../../src/notifications/preview/notification-preview.service';

const CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'in_app'];

describe('NotificationPreviewService.preview — currency', () => {
  const prisma = { user: { findUnique: jest.fn() } };
  const templateEngine = { render: jest.fn() };
  const abTesting = { resolveVariant: jest.fn() };
  const sendTimeOptimization = { decide: jest.fn() };
  const dndClassifier = { classify: jest.fn() };
  const frequencyCap = { getUsage: jest.fn() };
  const preferenceResolver = { resolve: jest.fn() };

  const service = new NotificationPreviewService(
    prisma as never,
    templateEngine as never,
    abTesting as never,
    sendTimeOptimization as never,
    dndClassifier as never,
    frequencyCap as never,
    preferenceResolver as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    abTesting.resolveVariant.mockResolvedValue({
      templateId: 'TXNX-005-v1',
      version: 1,
      isAbVariant: false,
    });
    dndClassifier.classify.mockReturnValue('TRANSACTIONAL');
    preferenceResolver.resolve.mockResolvedValue({ channels: CHANNELS });
    templateEngine.render.mockResolvedValue({ body: 'rendered' });
    frequencyCap.getUsage.mockResolvedValue({
      globalDaily: { used: 0, cap: 1 },
      channelDaily: { used: 0, cap: 1 },
      categoryHourly: { used: 0, cap: 1 },
    });
    sendTimeOptimization.decide.mockResolvedValue({
      optimize: false,
      reason: 'INSUFFICIENT_DATA',
    });
  });

  // Regression: the render() call was missing `currency` entirely, so every
  // preview showed INR (buildContext() defaults to 'INR' when it's absent),
  // even for an NG-market user, while the real send path always passes it
  // (notification-engine.service.ts). Preview must match what actually sends.
  it("passes the user's own market currency to the renderer, not a default", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-ng',
      name: 'Tunde',
      language: 'PCM',
      timezone: 'Africa/Lagos',
      market: 'NG',
      accountType: 'BASIC',
    });

    await service.preview('u-ng', 'TXNX-005', {
      amount: 200000,
      source: 'Paystack',
    });

    expect(templateEngine.render).toHaveBeenCalledWith(
      'TXNX-005-v1',
      'sms',
      expect.objectContaining({ currency: 'NGN' }),
    );
  });

  it('still passes INR for an IN-market user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-in',
      name: 'Priya',
      language: 'EN',
      timezone: 'Asia/Kolkata',
      market: 'IN',
      accountType: 'BASIC',
    });

    await service.preview('u-in', 'TXNX-005', {
      amount: 200000,
      source: 'UPI',
    });

    expect(templateEngine.render).toHaveBeenCalledWith(
      'TXNX-005-v1',
      'sms',
      expect.objectContaining({ currency: 'INR' }),
    );
  });
});
