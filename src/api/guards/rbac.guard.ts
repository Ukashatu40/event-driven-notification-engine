// src/api/guards/rbac.guard.ts
import {
  Injectable,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { type JwtPayload } from './jwt-auth.guard';

export const ROLES_KEY = 'roles';

/**
 * Role-based access control guard.
 *
 * Three roles (spec Section A10.1):
 * - ADMIN: full system access including DLQ management and analytics
 * - OPERATOR: read-only analytics, DLQ viewing
 * - SERVICE: machine-to-machine for internal microservices
 */
@Injectable()
export class RbacGuard {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: JwtPayload }>();

    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Role ${user.role} is not authorized for this resource`,
      );
    }

    return true;
  }
}
