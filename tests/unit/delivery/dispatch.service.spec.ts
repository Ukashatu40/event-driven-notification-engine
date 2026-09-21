// tests/unit/delivery/dispatch.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { randomBytes } from 'crypto';
import { DispatchService } from '../../../src/delivery/dispatch/dispatch.service';
import { PiiService } from '../../../src/shared/pii/pii.service';

const pii = new PiiService({
  get: (k: string) =>
    ({
      PII_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      PII_HASH_KEY: randomBytes(32).toString('hex'),
    })[k],
} as never);

describe('DispatchService (PII handling)', () => {
  const publish = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    user: { findUnique: jest.fn() },
    notification: { findUnique: jest.fn() },
  };
  const config = { get: () => ({ 1: 10, 2: 7, 3: 5, 5: 2 }) };
  let service: DispatchService;

  const user = () => ({
    id: 'u-1',
    phone: pii.encrypt('+2348012345678'),
    email: pii.encrypt('ada@example.ng'),
  });

  beforeEach(() => {
    jest.resetAllMocks();
    service = new DispatchService(
      { publish } as never,
      prisma,
      config as never,
      pii,
    );
  });

  it('decrypts the phone for sms and whatsapp, the email for email, the id otherwise', () => {
    expect(service.resolveRecipient(user(), 'sms')).toBe('+2348012345678');
    expect(service.resolveRecipient(user(), 'whatsapp')).toBe('+2348012345678');
    expect(service.resolveRecipient(user(), 'email')).toBe('ada@example.ng');
    expect(service.resolveRecipient(user(), 'push')).toBe('u-1');
    expect(service.resolveRecipient(user(), 'in_app')).toBe('u-1');
  });

  it('lookupRecipient loads the user and returns the decrypted address', async () => {
    prisma.user.findUnique.mockResolvedValue(user());
    await expect(service.lookupRecipient('u-1', 'sms')).resolves.toBe(
      '+2348012345678',
    );
  });

  it('lookupRecipient fails loudly for an unknown user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.lookupRecipient('nope', 'sms')).rejects.toThrow(
      /not found/,
    );
  });

  it('puts a user reference on the broker, never the phone or email', async () => {
    await service.publish({
      notificationId: 'n-1',
      userId: 'u-1',
      channel: 'sms',
      recipient: '+2348012345678',
      body: 'hi',
      priority: 1,
      correlationId: 'c-1',
    });

    const [routingKey, message, options] = publish.mock.calls[0];
    expect(routingKey).toBe('notifications.sms');
    expect(message.recipient).toBe('user:u-1');
    expect(JSON.stringify(message)).not.toContain('2348012345678');
    expect(options).toMatchObject({ priority: 10, persistent: true });
  });
});
