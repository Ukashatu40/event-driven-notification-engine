// tests/unit/api/rbac-policy.spec.ts
//
// Policy-completeness test: reflects over EVERY controller in the app and fails
// if any route is neither @Public() nor covered by @Roles(). This is what stops
// the RBAC model (spec A10.1.A) from silently decaying into "any valid token can
// do anything" — which is exactly what it was before the decorator existed.
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { RbacGuard, ROLES_KEY } from '../../../src/api/guards/rbac.guard';
import { JwtAuthGuard } from '../../../src/api/guards/jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../../../src/api/decorators/public.decorator';
import { AppController } from '../../../src/app.controller';
import { AuthController } from '../../../src/auth/auth.controller';
import { EventsController } from '../../../src/events/events.controller';
import { PreferencesController } from '../../../src/preferences/preferences.controller';
import { NotificationsController } from '../../../src/notifications/notifications.controller';
import { NotificationPreviewController } from '../../../src/notifications/preview/notification-preview.controller';
import { AnalyticsController } from '../../../src/analytics/analytics.controller';
import { AbTestingController } from '../../../src/templates/engine/ab-testing.controller';
import { HealthController } from '../../../src/health/health.controller';
import { WebhookDlrController } from '../../../src/delivery/webhooks/webhook-dlr.controller';
import { PaymentsController } from '../../../src/payments/payments.controller';
import { ConsentController } from '../../../src/compliance/consent.controller';
import { ComplianceAuditController } from '../../../src/compliance/audit/compliance-audit.controller';
import { UsersController } from '../../../src/users/users.controller';
import { MeController } from '../../../src/me/me.controller';
import {
  UserAuthController,
  SignupController,
} from '../../../src/auth/user-auth.controller';

const CONTROLLERS = [
  AppController,
  AuthController,
  EventsController,
  PreferencesController,
  NotificationsController,
  NotificationPreviewController,
  AnalyticsController,
  AbTestingController,
  HealthController,
  WebhookDlrController,
  PaymentsController,
  ConsentController,
  ComplianceAuditController,
  // Added after the fact, twice: UsersController shipped without being added
  // here, so this test was not actually covering it. Don't repeat that — a
  // new controller belongs in this list in the same commit that adds it.
  UsersController,
  MeController,
  UserAuthController,
  SignupController,
];

interface Route {
  controller: string;
  handler: string;
  verb: number;
  path: string;
  roles?: string[];
  isPublic: boolean;
}

const routes: Route[] = CONTROLLERS.flatMap((C) =>
  Object.getOwnPropertyNames(C.prototype)
    .filter(
      (n) =>
        n !== 'constructor' &&
        Reflect.getMetadata(
          'path',
          C.prototype[n as keyof typeof C.prototype],
        ) !== undefined,
    )
    .map((n) => {
      const fn = C.prototype[n as keyof typeof C.prototype] as object;
      return {
        controller: C.name,
        handler: n,
        verb: Reflect.getMetadata('method', fn) as number,
        path: String(Reflect.getMetadata('path', fn)),
        roles: (Reflect.getMetadata(ROLES_KEY, fn) ??
          Reflect.getMetadata(ROLES_KEY, C)) as string[] | undefined,
        isPublic: Boolean(
          Reflect.getMetadata(IS_PUBLIC_KEY, fn) ??
          Reflect.getMetadata(IS_PUBLIC_KEY, C),
        ),
      };
    }),
);

const roles = (controller: string, handler: string) =>
  routes.find((r) => r.controller === controller && r.handler === handler)
    ?.roles;

describe('RBAC policy completeness', () => {
  it('discovers a meaningful number of routes (guards against the reflection silently finding none)', () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  it('every route is either @Public() or restricted with @Roles()', () => {
    const unprotected = routes.filter(
      (r) => !r.isPublic && (!r.roles || r.roles.length === 0),
    );
    expect(unprotected.map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('no route is both public and role-restricted (contradictory policy)', () => {
    expect(
      routes
        .filter((r) => r.isPublic && r.roles?.length)
        .map((r) => `${r.controller}.${r.handler}`),
    ).toEqual([]);
  });
});

describe('RBAC policy — who may do what (spec A10.1.A)', () => {
  it('data erasure and DLQ resolution are ADMIN-only', () => {
    expect(roles('NotificationsController', 'eraseUserData')).toEqual([
      'ADMIN',
    ]);
    expect(roles('NotificationsController', 'resolveDlq')).toEqual(['ADMIN']);
  });

  it('OPERATOR can view the DLQ and analytics but not change anything', () => {
    expect(roles('NotificationsController', 'getDlq')).toContain('OPERATOR');
    for (const h of [
      'getDeliveryRates',
      'getChannelPerformance',
      'getOptOutTrends',
    ]) {
      expect(roles('AnalyticsController', h)).toContain('OPERATOR');
    }
    // POST /notifications/preview only computes what a user WOULD receive; it changes nothing.
    const READ_ONLY_POSTS = ['NotificationPreviewController.preview'];
    const writes = routes.filter(
      (r) =>
        r.verb !== 0 /* GET */ &&
        !r.isPublic &&
        !READ_ONLY_POSTS.includes(`${r.controller}.${r.handler}`),
    );
    for (const w of writes)
      expect({
        r: `${w.controller}.${w.handler}`,
        op: w.roles?.includes('OPERATOR'),
      }).toEqual({ r: `${w.controller}.${w.handler}`, op: false });
  });

  it('SERVICE (machine-to-machine) can ingest events but cannot read analytics or touch the DLQ', () => {
    expect(roles('EventsController', 'ingestEvent')).toContain('SERVICE');
    expect(roles('AnalyticsController', 'getDeliveryRates')).not.toContain(
      'SERVICE',
    );
    expect(roles('NotificationsController', 'getDlq')).not.toContain('SERVICE');
    expect(roles('NotificationsController', 'resolveDlq')).not.toContain(
      'SERVICE',
    );
  });

  it('consent: SERVICE/ADMIN can record it, OPERATOR can only read, audits are ADMIN/OPERATOR only', () => {
    expect(roles('ConsentController', 'record')).toEqual(['SERVICE', 'ADMIN']);
    expect(roles('ConsentController', 'history')).toContain('OPERATOR');
    expect(roles('ConsentController', 'status')).toContain('OPERATOR');
    for (const h of ['sms', 'promotionalConsent']) {
      expect(roles('ComplianceAuditController', h)).toEqual([
        'ADMIN',
        'OPERATOR',
      ]);
    }
  });

  it('auth, health and provider webhooks are public (they authenticate another way)', () => {
    for (const r of routes.filter((x) =>
      [
        'AuthController',
        'HealthController',
        'WebhookDlrController',
        'PaymentsController',
        'UserAuthController',
        'SignupController',
      ].includes(x.controller),
    )) {
      expect({
        r: `${r.controller}.${r.handler}`,
        isPublic: r.isPublic,
      }).toEqual({ r: `${r.controller}.${r.handler}`, isPublic: true });
    }
  });

  it('every /me route requires exactly the USER role, never ADMIN/OPERATOR/SERVICE', () => {
    const meRoutes = routes.filter((r) => r.controller === 'MeController');
    expect(meRoutes.length).toBeGreaterThan(0);
    for (const r of meRoutes) {
      expect({ r: `${r.controller}.${r.handler}`, roles: r.roles }).toEqual({
        r: `${r.controller}.${r.handler}`,
        roles: ['USER'],
      });
    }
  });

  it('the user directory (UsersController) is ops-only — USER is never listed', () => {
    expect(roles('UsersController', 'list')).toEqual([
      'ADMIN',
      'OPERATOR',
      'SERVICE',
    ]);
  });

  it("USER is never in an ops route's role list (no ops route accidentally reachable by an end-user token)", () => {
    const opsControllers = routes.filter(
      (r) =>
        r.controller !== 'MeController' &&
        r.controller !== 'UserAuthController' &&
        r.controller !== 'SignupController',
    );
    const leaked = opsControllers.filter((r) => r.roles?.includes('USER'));
    expect(leaked.map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });
});

const ctxFor = (
  handlerRoles: string[] | undefined,
  request: object,
  isPublic = false,
): ExecutionContext => {
  const handler = () => undefined;
  if (handlerRoles) Reflect.defineMetadata(ROLES_KEY, handlerRoles, handler);
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

describe('RbacGuard', () => {
  const guard = new RbacGuard(new Reflector());

  it('allows a role that is listed', () => {
    expect(
      guard.canActivate(ctxFor(['ADMIN'], { user: { role: 'ADMIN' } })),
    ).toBe(true);
  });
  it('forbids a role that is not listed', () => {
    expect(() =>
      guard.canActivate(ctxFor(['ADMIN'], { user: { role: 'OPERATOR' } })),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(ctxFor(['ADMIN'], { user: { role: 'SERVICE' } })),
    ).toThrow(/not authorized/);
  });
  it('forbids a restricted route when there is no authenticated user', () => {
    expect(() => guard.canActivate(ctxFor(['ADMIN'], {}))).toThrow(
      ForbiddenException,
    );
  });
  it('lets a route with no role requirement through', () => {
    expect(guard.canActivate(ctxFor(undefined, {}))).toBe(true);
  });
});

describe('JwtAuthGuard', () => {
  const SECRET = 'jwt-secret-'.padEnd(40, 'z');
  const guard = new JwtAuthGuard(
    { get: () => SECRET } as never,
    new Reflector(),
  );
  const req = (authorization?: string) =>
    ({ headers: { authorization } }) as never;

  it('lets @Public() routes through without a token', () => {
    expect(guard.canActivate(ctxFor(undefined, req(), true))).toBe(true);
  });
  it('rejects a missing or non-Bearer token', () => {
    expect(() => guard.canActivate(ctxFor(undefined, req()))).toThrow(
      /Missing authorization/,
    );
    expect(() =>
      guard.canActivate(ctxFor(undefined, req('Basic abc'))),
    ).toThrow(UnauthorizedException);
  });
  it('rejects a token signed with another secret and an expired token', () => {
    const forged = jwt.sign({ sub: 'u', role: 'ADMIN' }, 'attacker');
    expect(() =>
      guard.canActivate(ctxFor(undefined, req(`Bearer ${forged}`))),
    ).toThrow(/Invalid or expired/);
    const expired = jwt.sign({ sub: 'u', role: 'ADMIN' }, SECRET, {
      expiresIn: -10,
    });
    expect(() =>
      guard.canActivate(ctxFor(undefined, req(`Bearer ${expired}`))),
    ).toThrow(UnauthorizedException);
  });
  it('rejects a REFRESH token (or an untyped one) even when it is signed with the same secret', () => {
    const refresh = jwt.sign(
      { sub: 'u', role: 'ADMIN', typ: 'refresh', jti: 'j', fam: 'f' },
      SECRET,
    );
    const untyped = jwt.sign({ sub: 'u', role: 'ADMIN' }, SECRET);
    expect(() =>
      guard.canActivate(ctxFor(undefined, req(`Bearer ${refresh}`))),
    ).toThrow(/Invalid or expired/);
    expect(() =>
      guard.canActivate(ctxFor(undefined, req(`Bearer ${untyped}`))),
    ).toThrow(/Invalid or expired/);
  });

  it('accepts a valid token and attaches the user to the request', () => {
    const token = jwt.sign(
      { sub: 'u-1', role: 'OPERATOR', typ: 'access' },
      SECRET,
    );
    const request = { headers: { authorization: `Bearer ${token}` } };
    expect(guard.canActivate(ctxFor(undefined, request))).toBe(true);
    expect((request as unknown as { user: { role: string } }).user.role).toBe(
      'OPERATOR',
    );
  });
});
