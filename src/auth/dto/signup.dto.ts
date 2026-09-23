// src/auth/dto/signup.dto.ts
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RequestSignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(['IN', 'NG'])
  market?: string;

  @IsOptional()
  @IsIn(['EN', 'HI', 'MR', 'TA', 'TE', 'PCM', 'HA', 'YO', 'IG'])
  language?: string;
}

export class VerifySignupDto {
  @IsString()
  @IsNotEmpty()
  requestId!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
