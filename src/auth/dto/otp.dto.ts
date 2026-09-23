// src/auth/dto/otp.dto.ts
import {
  IsEmail,
  IsOptional,
  IsString,
  IsNotEmpty,
  Length,
} from 'class-validator';

export class RequestOtpDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  requestId!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
