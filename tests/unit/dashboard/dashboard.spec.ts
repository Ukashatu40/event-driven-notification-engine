// tests/unit/dashboard/dashboard.spec.ts
import * as jwt from 'jsonwebtoken';
import { JwtService } from '@nestjs/jwt';
import { DashboardGateway } from '../../../src/dashboard/dashboard.gateway';
import { WsJwtGuard } from '../../../src/dashboard/ws-jwt.guard';

const SECRET = 'ws-secret-'.padEnd(40, 'q');
const jwtService = new JwtService({ secret: SECRET });
const tokenFor = (role: string, secret = SECRET, typ = 'access') =>
  jwt.sign({ sub: 'u', role, typ }, secret);

describe('WsJwtGuard', () => {
  const guard = new WsJwtGuard(jwtService);

  it('accepts ADMIN and OPERATOR tokens (the roles real tokens actually carry)', () => {
    expect(guard.isAuthorized(tokenFor('ADMIN'))).toBe(true);
    expect(guard.isAuthorized(tokenFor('OPERATOR'))).toBe(true);
  });

  it('rejects SERVICE — a machine token has no business watching the dashboard', () => {
    expect(guard.isAuthorized(tokenFor('SERVICE'))).toBe(false);
  });

  it('rejects a refresh token: only ACCESS tokens may watch the dashboard', () => {
    expect(guard.isAuthorized(tokenFor('ADMIN', SECRET, 'refresh'))).toBe(
      false,
    );
  });

  it('rejects the lowercase roles the old guard expected, which no token ever had', () => {
    expect(guard.isAuthorized(tokenFor('admin'))).toBe(false);
    expect(guard.isAuthorized(tokenFor('ops'))).toBe(false);
  });

  it.each([[undefined], [''], [123], [null], ['garbage']])(
    'rejects a missing/invalid token: %p',
    (t) => {
      expect(guard.isAuthorized(t)).toBe(false);
    },
  );

  it('rejects a token signed with another secret and an expired one', () => {
    expect(guard.isAuthorized(tokenFor('ADMIN', 'attacker-secret'))).toBe(
      false,
    );
    expect(
      guard.isAuthorized(
        jwt.sign({ sub: 'u', role: 'ADMIN' }, SECRET, { expiresIn: -5 }),
      ),
    ).toBe(false);
  });

  it('canActivate reads the token from the socket handshake', () => {
    const ctx = (token?: string) =>
      ({
        switchToWs: () => ({
          getClient: () => ({ id: 's1', handshake: { auth: { token } } }),
        }),
      }) as never;
    expect(guard.canActivate(ctx(tokenFor('OPERATOR')))).toBe(true);
    expect(guard.canActivate(ctx(undefined))).toBe(false);
  });
});

describe('DashboardGateway', () => {
  const prom = {
    activeWebSocketConnections: { inc: jest.fn(), dec: jest.fn() },
  };
  const guard = new WsJwtGuard(jwtService);
  const build = (enabled = true) => {
    const g = new DashboardGateway(
      { get: () => enabled } as never,
      prom as never,
      guard,
    );
    const emit = jest.fn();
    g.server = { to: jest.fn(() => ({ emit })) } as never;
    return { g, emit };
  };
  const socket = (token?: string) =>
    ({
      id: 's1',
      handshake: { auth: { token } },
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }) as never as Record<string, jest.Mock> & { handshake: unknown };
  beforeEach(() => jest.clearAllMocks());

  describe('connection', () => {
    it('DROPS an anonymous socket before it can join a room (the old gateway let everyone in)', () => {
      const { g } = build();
      const s = socket();
      g.handleConnection(s as never);
      expect(s.disconnect).toHaveBeenCalledWith(true);
      expect(prom.activeWebSocketConnections.inc).not.toHaveBeenCalled();
    });

    it('drops a socket whose token has the wrong role', () => {
      const { g } = build();
      const s = socket(tokenFor('SERVICE'));
      g.handleConnection(s as never);
      expect(s.disconnect).toHaveBeenCalledWith(true);
    });

    it('accepts an OPERATOR and counts the connection', () => {
      const { g } = build();
      const s = socket(tokenFor('OPERATOR'));
      g.handleConnection(s as never);
      expect(s.disconnect).not.toHaveBeenCalled();
      expect(prom.activeWebSocketConnections.inc).toHaveBeenCalled();
    });

    it('disconnects everyone when the dashboard feature is switched off', () => {
      const { g } = build(false);
      const s = socket(tokenFor('ADMIN'));
      g.handleConnection(s as never);
      expect(s.disconnect).toHaveBeenCalledWith(true);
    });

    it('decrements the gauge on disconnect', () => {
      build().g.handleDisconnect(socket() as never);
      expect(prom.activeWebSocketConnections.dec).toHaveBeenCalled();
    });
  });

  describe('subscriptions and broadcasts', () => {
    it('joins the firehose or a user room and confirms', () => {
      const { g } = build();
      const s = socket(tokenFor('ADMIN'));
      g.handleFirehoseSubscribe(s as never);
      g.handleUserSubscribe({ userId: 'u-9' }, s as never);
      expect(s.join).toHaveBeenCalledWith('firehose');
      expect(s.join).toHaveBeenCalledWith('user:u-9');
      expect(s.emit).toHaveBeenCalledWith('subscribed', {
        channel: 'user:u-9',
      });
    });

    it("broadcasts a state change to the firehose AND that user's room", () => {
      const { g, emit } = build();
      const ev = {
        notificationId: 'n',
        userId: 'u-1',
        eventType: 'X',
        channel: 'sms',
        fromStatus: 'A',
        toStatus: 'B',
        timestamp: 't',
      };
      g.broadcastStateChange(ev);
      expect(
        (g.server as unknown as { to: jest.Mock }).to,
      ).toHaveBeenCalledWith('firehose');
      expect(
        (g.server as unknown as { to: jest.Mock }).to,
      ).toHaveBeenCalledWith('user:u-1');
      expect(emit).toHaveBeenCalledTimes(2);
    });

    it('broadcasts stats to the firehose only', () => {
      const { g, emit } = build();
      g.broadcastStats({ sent: 1 });
      expect(emit).toHaveBeenCalledWith('stats:update', { sent: 1 });
    });

    it('broadcasts nothing when disabled', () => {
      const { g, emit } = build(false);
      g.broadcastStateChange({} as never);
      g.broadcastStats({});
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
