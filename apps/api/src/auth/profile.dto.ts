import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsTimeZone, Trim } from '../common/validation';

export class ProfileDto {
  @IsOptional() @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  /** null = use the portal's timezone. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsTimeZone()
  timezone?: string | null;
}
