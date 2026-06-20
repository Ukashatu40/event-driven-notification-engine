// src/api/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark a route as public — bypasses JWT authentication.
 * Used for /health, /ready, /live, /metrics, /auth/login.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
