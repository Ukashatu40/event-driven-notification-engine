// src/api/decorators/current-user-id.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { JwtPayload } from '../guards/jwt-auth.guard';

/**
 * The verified caller's own id, from the JWT's `sub` claim — never from a
 * route parameter or the request body. This is what makes the `/me/*` routes
 * (src/me/) safe by construction: there is no id anywhere in the request for
 * one user to substitute another user's id into.
 */
export const CurrentUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const request = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user: JwtPayload }>();
    return request.user.sub;
  },
);
