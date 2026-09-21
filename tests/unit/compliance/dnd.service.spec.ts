// tests/unit/compliance/dnd.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { DndService } from '../../../src/compliance/dnd/dnd.service';
import { DndClassifierService } from '../../../src/compliance/dnd/dnd-classifier.service';
import { RedisService } from '../../../src/infrastructure/redis/redis.service';
import { PrismaService } from '../../../src/infrastructure/database/prisma.service';
import { PrometheusService } from '../../../src/health/prometheus/prometheus.service';

const PHONE = '+919876543210';
const USER = 'user-1';

describe('DndService.check (dispatch-time DND)', () => {
  const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { user: { findUnique: jest.fn() } };
  const prometheus = { recordDndBlock: jest.fn() };
  let service: DndService;

  const registered = () => redis.get.mockResolvedValue('registered');
  const notRegistered = () => redis.get.mockResolvedValue('not_registered');

  beforeEach(() => {
    jest.resetAllMocks();
    service = new DndService(
      redis as unknown as RedisService,
      prisma as PrismaService,
      prometheus as unknown as PrometheusService,
      new DndClassifierService(),
    );
  });

  it('does not consult the registry for channels outside DND scope', async () => {
    const r = await service.check(USER, PHONE, 'MKTX-001', 'push');
    expect(r).toMatchObject({
      allowed: true,
      registryStatus: 'NOT_CHECKED',
      reason: 'CHANNEL_NOT_SUBJECT_TO_DND',
    });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('blocks a PROMOTIONAL SMS to a DND-registered user', async () => {
    registered();
    const r = await service.check(USER, PHONE, 'MKTX-001', 'sms');
    expect(r).toMatchObject({
      allowed: false,
      classification: 'PROMOTIONAL',
      registryStatus: 'REGISTERED',
      reason: 'DND_REGISTERED_PROMOTIONAL_BLOCKED',
    });
    expect(prometheus.recordDndBlock).toHaveBeenCalledWith('PROMOTIONAL');
  });

  it('allows a PROMOTIONAL SMS to a user who is not registered', async () => {
    notRegistered();
    const r = await service.check(USER, PHONE, 'MKTX-001', 'sms');
    expect(r).toMatchObject({
      allowed: true,
      registryStatus: 'NOT_REGISTERED',
    });
  });

  it('allows a TRANSACTIONAL SMS to a registered user (exempt)', async () => {
    registered();
    const r = await service.check(USER, PHONE, 'TXNX-001', 'sms');
    expect(r).toMatchObject({
      allowed: true,
      classification: 'TRANSACTIONAL',
      reason: 'TRANSACTIONAL_EXEMPT',
      regulatoryOverride: false,
    });
  });

  it('allows a CRITICAL margin call to a registered user and flags the override', async () => {
    registered();
    const r = await service.check(USER, PHONE, 'RISK-001', 'sms');
    expect(r).toMatchObject({
      allowed: true,
      reason: 'CRITICAL_EVENT_BYPASS',
      registryStatus: 'REGISTERED',
      regulatoryOverride: true,
    });
  });

  it('still looks the registry up for exempt messages so the audit record proves the check', async () => {
    notRegistered();
    const r = await service.check(USER, PHONE, 'RISK-001', 'sms');
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(r.registryStatus).toBe('NOT_REGISTERED');
    expect(new Date(r.checkedAt).getTime()).not.toBeNaN();
  });

  it('fails CLOSED for PROMOTIONAL when the registry is unreachable', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const r = await service.check(USER, PHONE, 'MKTX-001', 'sms');
    expect(r).toMatchObject({
      allowed: false,
      registryStatus: 'UNKNOWN',
      registryUnavailable: true,
      reason: 'DND_CHECK_UNAVAILABLE',
    });
  });

  it('never withholds a CRITICAL message because the registry is down', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const r = await service.check(USER, PHONE, 'RISK-002', 'sms');
    expect(r).toMatchObject({ allowed: true, registryUnavailable: true });
  });

  it('falls back to the database by user id on a cache miss, then caches it', async () => {
    redis.get.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ dndStatus: 'REGISTERED' });
    const r = await service.check(USER, PHONE, 'MKTX-001', 'sms');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER },
      select: { dndStatus: true },
    });
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      'registered',
      expect.any(Number),
    );
    expect(r.allowed).toBe(false);
  });
});
