// src/auth/auth.controller.ts
import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { Public } from '../api/decorators/public.decorator';
import { AuthService } from './auth.service';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  serviceKey!: string;

  @IsString()
  @IsIn(['ADMIN', 'OPERATOR', 'SERVICE'])
  role!: 'ADMIN' | 'OPERATOR' | 'SERVICE';
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Obtain a JWT access token',
    description:
      'Authenticates using a service key and returns a short-lived JWT (1h) ' +
      'plus a refresh token. Roles: ADMIN (full access), OPERATOR (read-only), SERVICE (m2m).',
  })
  @ApiResponse({
    status: 200,
    description: 'Token issued',
    schema: {
      example: {
        access_token: 'eyJ...',
        refresh_token: 'eyJ...',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid service key' })
  async login(@Body() dto: LoginDto): Promise<object> {
    return this.authService.login(dto.serviceKey, dto.role);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh an access token using a refresh token',
    description: 'Issues a new short-lived JWT. Rotates the refresh token.',
  })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body() dto: RefreshDto): Promise<object> {
    return this.authService.refresh(dto.refreshToken);
  }
}
