// src/api/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../guards/rbac.guard';

export type Role = 'ADMIN' | 'OPERATOR' | 'SERVICE' | 'USER';

/**
 * Restricts a route (or a whole controller) to the given roles (spec A10.1.A):
 *  - ADMIN    — full access, including DLQ management and data erasure
 *  - OPERATOR — read-only: analytics, DLQ and notification viewing
 *  - SERVICE  — machine-to-machine: event ingestion, preference/notification writes
 *  - USER     — an end user, verified by OTP (see OtpService). Scoped to their
 *               OWN data only, via the `/me/*` routes (src/me/) — a USER token
 *               has no `:userId`-parameterised route it can reach, so there is
 *               no ownership check to forget.
 *
 * Every non-public route must declare one — tests/unit/api/rbac-policy.spec.ts
 * fails the build if a route is left without a policy.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
