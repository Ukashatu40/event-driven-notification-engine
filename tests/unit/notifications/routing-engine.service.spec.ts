// tests/unit/notifications/routing-engine.service.spec.ts
import { RoutingEngineService } from '../../../src/notifications/routing/routing-engine.service';

describe('RoutingEngineService', () => {
  const resolver = { resolve: jest.fn() };
  const caps = { check: jest.fn() };
  const quiet = { check: jest.fn() };
  const prom = { recordCapHit: jest.fn() };
  let routing: RoutingEngineService;

  const user = { userId: 'u', accountType: 'BASIC', timezone: 'Africa/Lagos' };
  const resolved = (channels: string[], over = {}) =>
    resolver.resolve.mockResolvedValue({
      channels,
      regulatoryOverride: false,
      digestMode: 'IMMEDIATE',
      quietHoursOverride: false,
      ...over,
    });

  beforeEach(() => {
    jest.resetAllMocks();
    caps.check.mockResolvedValue({ capped: false });
    quiet.check.mockResolvedValue({ suppressed: false });
    routing = new RoutingEngineService(
      resolver as never,
      caps as never,
      quiet as never,
      prom as never,
    );
  });

  it('passes the resolved channels through when nothing suppresses them', async () => {
    resolved(['sms', 'push']);
    const d = await routing.route('TXNX-001', user, 2);
    expect(d.channels.sort()).toEqual(['push', 'sms']);
    expect(d.suppressedChannels).toEqual([]);
  });

  it('does NOT check DND here — that happens at dispatch (ADR-004)', async () => {
    resolved(['sms']);
    await routing.route('MKTX-001', user, 2);
    // the constructor takes no DND service at all
    expect(routing.constructor.length).toBe(4);
  });

  it('drops a channel that hit a frequency cap and records why', async () => {
    resolved(['sms', 'push']);
    caps.check.mockImplementation(async (_u: string, _e: string, ch: string) =>
      ch === 'sms'
        ? { capped: true, reason: 'SMS daily cap' }
        : { capped: false },
    );
    const d = await routing.route('MKTX-001', user, 2);
    expect(d.channels).toEqual(['push']);
    expect(d.suppressedChannels).toEqual([
      { channel: 'sms', reason: 'SMS daily cap' },
    ]);
    expect(prom.recordCapHit).toHaveBeenCalledWith('routing', 'MKTX-001');
  });

  it('defers everything that is left when the user is in quiet hours', async () => {
    resolved(['push', 'in_app']);
    quiet.check.mockResolvedValue({
      suppressed: true,
      deliverAt: '2026-09-22T07:00:00.000Z',
    });
    const d = await routing.route('MKTX-004', user, 3);
    expect(d.channels).toEqual([]);
    expect(d.quietHoursDelay).toEqual({
      deliverAt: '2026-09-22T07:00:00.000Z',
    });
    expect(d.suppressedChannels.map((s) => s.reason)).toEqual([
      'QUIET_HOURS',
      'QUIET_HOURS',
    ]);
  });

  it('does not consult quiet hours when nothing survived the caps (no empty deferral)', async () => {
    resolved(['sms']);
    caps.check.mockResolvedValue({ capped: true, reason: 'cap' });
    const d = await routing.route('MKTX-001', user, 2);
    expect(quiet.check).not.toHaveBeenCalled();
    expect(d.quietHoursDelay).toBeUndefined();
    expect(d.channels).toEqual([]);
  });

  it('ranks urgent-event SMS/push above email/whatsapp, and cheaper channels above dearer ones', async () => {
    resolved(['whatsapp', 'email', 'sms', 'push', 'in_app']);
    const d = await routing.route('TXNX-001', user, 2);
    expect(d.channels.indexOf('sms')).toBeLessThan(
      d.channels.indexOf('whatsapp'),
    );
    expect(d.channels.indexOf('push')).toBeLessThan(
      d.channels.indexOf('email'),
    );
  });

  it('a CRITICAL event outranks by the regulatory weight and records the policies it bypassed', async () => {
    resolved(['sms', 'push'], { regulatoryOverride: true });
    const d = await routing.route('RISK-001', user, 1);
    expect(d.regulatoryOverride).toBe(true);
    expect(d.policyBypasses).toEqual(['frequency_cap', 'quiet_hours']);
  });

  it('a non-critical event records no bypasses', async () => {
    resolved(['sms']);
    expect(
      (await routing.route('TXNX-004', user, 3)).policyBypasses,
    ).toBeUndefined();
  });

  it("asks the resolver with the user's account type (segment layer)", async () => {
    resolved(['push']);
    await routing.route('SIPX-001', { ...user, accountType: 'HNI' }, 3);
    expect(resolver.resolve).toHaveBeenCalledWith('u', 'SIPX-001', 'HNI');
  });
});
