// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { OtpCodeStore } from './otp-code-store.service';
import { OtpCodeDeliveryService } from './otp-code-delivery.service';
import { SignupService } from './signup.service';
import { UserAuthController, SignupController } from './user-auth.controller';

@Module({
  imports: [DeliveryModule],
  controllers: [AuthController, UserAuthController, SignupController],
  providers: [
    AuthService,
    OtpCodeStore,
    OtpCodeDeliveryService,
    OtpService,
    SignupService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
