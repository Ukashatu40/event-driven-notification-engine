// tests/unit/health/health.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import {
  HealthService,
  PROVIDER_NAMES,
} from '../../../src/health/health.service';
import { HealthController } from '../../../src/health/health.controller';
import { PrometheusService } from '../../../src/health/prometheus/prometheus.service';

describe('HealthService', () => {
  const prisma = { $queryRaw: jest.fn() };
  const redis = { ping: jest.fn(), get: jest.fn() };
  const kafka = { ping: jest.fn() };
  const rabbit = { ping: jest.fn() };
  let svc: HealthService;

  const allUp = () => {
    prisma.$queryRaw.mockResolvedValue([1]);
    redis.ping.mockResolvedValue(true);
    redis.get.mockResolvedValue(null); // no circuit state = CLOSED
    kafka.ping.mockResolvedValue(true);
    rabbit.ping.mockResolvedValue(true);
  };

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new HealthService(
      prisma as never,
      redis as never,
      kafka as never,
      rabbit as never,
    );
  });

  it('is healthy when every component and provider is up', async () => {
    allUp();
    const h = await svc.getHealth();
    expect(h.status).toBe('healthy');
    expect(Object.keys(h.components)).toEqual([
      'database',
      'redis',
      'kafka',
      'rabbitmq',
      'providers',
    ]);
    expect(h.components.providers.status).toBe('up');
  });

  it('is unhealthy when the database is down, and reports why', async () => {
    allUp();
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    const h = await svc.getHealth();
    expect(h.status).toBe('unhealthy');
    expect(h.components.database).toMatchObject({
      status: 'down',
      detail: 'connection refused',
    });
  });

  it.each([
    ['redis', () => redis.ping.mockResolvedValue(false)],
    ['kafka', () => kafka.ping.mockRejectedValue(new Error('x'))],
    ['rabbitmq', () => rabbit.ping.mockResolvedValue(false)],
  ])('is unhealthy when %s is down', async (name, breakIt) => {
    allUp();
    breakIt();
    const h = await svc.getHealth();
    expect(h.status).toBe('unhealthy');
    expect(
      (h.components as Record<string, { status: string }>)[name].status,
    ).toBe('down');
  });

  describe('providers (spec Day 12: "check all providers")', () => {
    it('checks every provider by its circuit-breaker state', async () => {
      allUp();
      await svc.getHealth();
      expect(redis.get).toHaveBeenCalledTimes(PROVIDER_NAMES.length);
      expect(PROVIDER_NAMES).toEqual(
        expect.arrayContaining([
          'msg91',
          'termii',
          'twilio',
          'fcm',
          'nodemailer',
          'whatsapp_cloud',
          'in_app',
        ]),
      );
    });

    it('an OPEN provider makes the system DEGRADED, not down — SMS fails over and other channels are unaffected', async () => {
      allUp();
      redis.get.mockImplementation(async (k: string) =>
        k.includes('msg91') ? 'OPEN' : k.includes('fcm') ? 'HALF_OPEN' : null,
      );
      const h = await svc.getHealth();
      expect(h.status).toBe('degraded');
      expect(h.components.providers).toMatchObject({
        status: 'degraded',
        detail: 'msg91=OPEN, fcm=HALF_OPEN',
      });
    });
  });

  describe('probes', () => {
    it('ready needs only the database and Redis', async () => {
      allUp();
      kafka.ping.mockResolvedValue(false);
      expect(await svc.isReady()).toBe(true);
      redis.ping.mockResolvedValue(false);
      expect(await svc.isReady()).toBe(false);
    });
    it('live is true whenever the process can answer', () => {
      expect(svc.isAlive()).toBe(true);
    });
  });
});

describe('HealthController', () => {
  const reply = () => {
    const r: any = { status: jest.fn(), send: jest.fn(), header: jest.fn() };
    r.status.mockReturnValue(r);
    r.header.mockReturnValue(r);
    return r;
  };
  const health = {
    getHealth: jest.fn(),
    isReady: jest.fn(),
    isAlive: jest.fn().mockReturnValue(true),
  };
  const prom = { getMetrics: jest.fn() };
  const c = new HealthController(health as never, prom as never);
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['healthy', 200],
    ['degraded', 200],
    ['unhealthy', 503],
  ])('/health %s → HTTP %i', async (status, code) => {
    health.getHealth.mockResolvedValue({ status });
    const r = reply();
    await c.health(r);
    expect(r.status).toHaveBeenCalledWith(code);
  });

  it('/ready is 200 when ready, 503 when not', async () => {
    const ok = reply();
    health.isReady.mockResolvedValue(true);
    await c.ready(ok);
    const no = reply();
    health.isReady.mockResolvedValue(false);
    await c.ready(no);
    expect(ok.status).toHaveBeenCalledWith(200);
    expect(no.status).toHaveBeenCalledWith(503);
  });

  it('/live reports alive', () => {
    health.isAlive.mockReturnValue(true);
    expect(c.alive().alive).toBe(true);
  });

  it('/metrics serves Prometheus text format', async () => {
    prom.getMetrics.mockResolvedValue('# HELP x\nx 1\n');
    const r = reply();
    await c.metrics(r);
    expect(r.header).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/plain'),
    );
    expect(r.send).toHaveBeenCalledWith('# HELP x\nx 1\n');
  });
});

describe('PrometheusService — the metrics the spec requires (A11.1) exist and move', () => {
  const p = new PrometheusService();

  it('exposes every required metric name', async () => {
    p.recordDelivery('sms', 'msg91', 'delivered', 120, '1');
    p.recordCapHit('global_daily', 'MKTX-001');
    p.recordDndBlock('PROMOTIONAL');
    p.setCircuitState('msg91', 'sms', 'OPEN');
    p.notificationEventsReceived.inc({ event_type: 'RISK-001', priority: '1' });
    p.notificationDlqDepth.set(3);
    p.notificationRetryTotal.inc({ attempt: '1', provider: 'msg91' });
    p.kafkaConsumerLag.set(
      { topic: 't', partition: '0', consumer_group: 'g' },
      5,
    );
    p.dndViolationsDetected.inc({
      channel: 'sms',
      classification: 'PROMOTIONAL',
    });
    const text = await p.getMetrics();
    for (const name of [
      'notification_events_received_total',
      'notification_delivery_total',
      'notification_delivery_latency_seconds',
      'notification_frequency_cap_hits_total',
      'notification_dnd_blocks_total',
      'notification_dlq_depth',
      'notification_retry_total',
      'kafka_consumer_lag',
      'delivery_provider_circuit_state',
      'dnd_violations_detected_total',
    ]) {
      expect({ name, present: text.includes(name) }).toEqual({
        name,
        present: true,
      });
    }
  });

  it('encodes circuit state as 0=CLOSED, 1=HALF_OPEN, 2=OPEN', async () => {
    p.setCircuitState('a', 'sms', 'CLOSED');
    p.setCircuitState('b', 'sms', 'HALF_OPEN');
    p.setCircuitState('c', 'sms', 'OPEN');
    const text = await p.getMetrics();
    expect(text).toMatch(
      /delivery_provider_circuit_state\{provider="a",channel="sms"\} 0/,
    );
    expect(text).toMatch(
      /delivery_provider_circuit_state\{provider="b",channel="sms"\} 1/,
    );
    expect(text).toMatch(
      /delivery_provider_circuit_state\{provider="c",channel="sms"\} 2/,
    );
  });

  it('records delivery latency in seconds per channel', async () => {
    p.recordDeliveryLatency('sms', 4.2);
    expect(await p.getMetrics()).toMatch(
      /notification_delivery_latency_seconds_(bucket|count).*channel="sms"/,
    );
  });
});
