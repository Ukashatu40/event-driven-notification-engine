// tests/unit/webhooks/dlr-fail-closed.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { WebhookDlrController } from '../../../src/delivery/webhooks/webhook-dlr.controller';

const build = (env: Record<string, string>) =>
  new WebhookDlrController(
    { get: (k: string) => env[k] } as never,
    { notification: { findFirst: jest.fn().mockResolvedValue(null) } } as never,
    { transition: jest.fn() } as never,
    { recordDeliveryLatency: jest.fn() } as never,
  );

const req = (body: object) =>
  ({ rawBody: Buffer.from(JSON.stringify(body)) }) as never;

describe('DLR webhooks fail CLOSED', () => {
  const body = { request_id: 'r-1', status: 'DELIVRD' };

  it('rejects an MSG91 callback when no webhook secret is configured (was: silently accepted)', async () => {
    const c = build({});
    await expect(
      c.msg91Dlr(body as never, 'anything', req(body)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a Twilio callback when no auth token is configured', async () => {
    const c = build({});
    await expect(c.twilioDlr(body as never, 'sig', req(body))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a callback with a wrong signature even when the secret is configured', async () => {
    const c = build({ 'app.webhooks.msg91Secret': 's3cret' });
    await expect(
      c.msg91Dlr(body as never, '00'.repeat(32), req(body)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a correctly signed callback', async () => {
    const c = build({ 'app.webhooks.msg91Secret': 's3cret' });
    const sig = createHmac('sha256', 's3cret')
      .update(JSON.stringify(body))
      .digest('hex');
    await expect(
      c.msg91Dlr(body as never, sig, req(body)),
    ).resolves.toBeDefined();
  });
});
