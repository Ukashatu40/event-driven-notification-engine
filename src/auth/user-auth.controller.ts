// src/auth/user-auth.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../api/decorators/public.decorator';
import { OtpService } from './otp.service';
import { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { SignupService } from './signup.service';
import { RequestSignupDto, VerifySignupDto } from './dto/signup.dto';

@ApiTags('auth')
@Controller({ path: 'auth/otp', version: '1' })
export class UserAuthController {
  constructor(private readonly otp: OtpService) {}

  @Public()
  @Throttle({ standard: { limit: 10, ttl: 60_000 } })
  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a login code, by SMS or email',
    description:
      'Provide exactly one of `phone` (SMS) or `email`. Always returns the same ' +
      'shape whether or not the identifier belongs to an account — this endpoint ' +
      'cannot be used to check which phone numbers or emails are registered.',
  })
  @ApiResponse({ status: 200, description: 'A code was requested' })
  async request(@Body() dto: RequestOtpDto): Promise<object> {
    return this.otp.request({ phone: dto.phone, email: dto.email });
  }

  @Public()
  @Throttle({ standard: { limit: 20, ttl: 60_000 } })
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a login code and receive a USER token' })
  @ApiResponse({ status: 200, description: 'Token issued' })
  @ApiResponse({ status: 401, description: 'Incorrect or expired code' })
  async verify(@Body() dto: VerifyOtpDto): Promise<object> {
    return this.otp.verify(dto.requestId, dto.code);
  }
}

/**
 * Self-service sign-up (ADR-009). A DIFFERENT security posture from login,
 * on purpose: this one says plainly when an identifier is already
 * registered, where login never does — see SignupService's class doc.
 */
@ApiTags('auth')
@Controller({ path: 'auth/signup', version: '1' })
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Public()
  // Stricter than login's request throttle — creating an account is more
  // sensitive than requesting a login code for one that may not exist.
  @Throttle({ standard: { limit: 5, ttl: 60_000 } })
  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start creating an account: request a verification code',
    description:
      'Provide a name and exactly one of `phone` (SMS) or `email`. Unlike ' +
      '/auth/otp/request, this DOES say if the identifier is already registered ' +
      '(409) — you cannot sign up twice with the same phone/email.',
  })
  @ApiResponse({ status: 200, description: 'A code was sent' })
  @ApiResponse({
    status: 409,
    description: 'That phone/email is already registered',
  })
  async request(@Body() dto: RequestSignupDto): Promise<object> {
    return this.signup.request({
      name: dto.name,
      phone: dto.phone,
      email: dto.email,
      market: dto.market,
      language: dto.language,
    });
  }

  @Public()
  @Throttle({ standard: { limit: 10, ttl: 60_000 } })
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish creating the account and receive a USER token',
  })
  @ApiResponse({ status: 200, description: 'Account created, token issued' })
  @ApiResponse({ status: 401, description: 'Incorrect or expired code' })
  @ApiResponse({
    status: 409,
    description: 'Someone else registered this identifier first',
  })
  async verify(@Body() dto: VerifySignupDto): Promise<object> {
    return this.signup.verify(dto.requestId, dto.code);
  }
}
