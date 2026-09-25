import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Shared password rule for signup, reset, invite and change. */
const Password = () => (target: object, key: string) => {
  IsString()(target, key);
  MinLength(8, { message: 'Password must be at least 8 characters' })(target, key);
  MaxLength(128)(target, key);
};

export class SignupDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  companyName: string;

  @Transform(trimLower)
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/, {
    message: 'Subdomain must be 3–32 characters: lowercase letters, numbers and dashes',
  })
  subdomain: string;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @Transform(trimLower) @IsEmail()
  email: string;

  @Password()
  password: string;
}

export class LoginDto {
  @Transform(trimLower) @IsEmail()
  email: string;

  @IsString() @MinLength(1)
  password: string;
}

export class HandoffDto {
  @IsString()
  handoffToken: string;
}

export class TwofaLoginDto {
  @IsString()
  challengeToken: string;

  @Transform(trim) @Length(6, 6, { message: 'Enter the 6-digit code' })
  code: string;
}

export class EmailDto {
  @Transform(trimLower) @IsEmail()
  email: string;
}

export class TokenDto {
  @IsString()
  token: string;
}

export class ResetPasswordDto {
  @IsString()
  token: string;

  @Password()
  password: string;
}

export class AcceptInviteDto {
  @IsString()
  token: string;

  @Password()
  password: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  name?: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @Password()
  newPassword: string;
}

export class CodeDto {
  @Transform(trim) @Length(6, 6, { message: 'Enter the 6-digit code' })
  code: string;
}

export class PasswordDto {
  @IsString() @MinLength(1)
  password: string;
}
