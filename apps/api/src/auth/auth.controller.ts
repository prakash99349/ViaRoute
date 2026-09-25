import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Tenant } from '@viaroute/db';
import { CurrentTenant, CurrentUser, Public } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { AuthService } from './auth.service';
import { ProfileDto } from './profile.dto';
import {
  AcceptInviteDto, ChangePasswordDto, CodeDto, EmailDto, HandoffDto, LoginDto, PasswordDto,
  ResetPasswordDto, SignupDto, TokenDto, TwofaLoginDto,
} from './dto';

const STRICT = { default: { limit: 5, ttl: 60_000 } };
const NORMAL = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // --- Public ---------------------------------------------------------------

  @Public() @Throttle(STRICT) @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Public() @Throttle(NORMAL) @HttpCode(200) @Post('login')
  login(@Body() dto: LoginDto, @CurrentTenant() tenant: Tenant | null) {
    return this.auth.login(dto, tenant);
  }

  @Public() @Throttle(NORMAL) @HttpCode(200) @Post('login/2fa')
  loginTwofa(@Body() dto: TwofaLoginDto, @CurrentTenant() tenant: Tenant | null) {
    return this.auth.verifyTwofaLogin(dto.challengeToken, dto.code, tenant);
  }

  @Public() @HttpCode(200) @Post('handoff')
  handoff(@Body() dto: HandoffDto, @CurrentTenant() tenant: Tenant | null) {
    return this.auth.redeemHandoff(dto.handoffToken, tenant);
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('forgot-password')
  forgot(@Body() dto: EmailDto, @CurrentTenant() tenant: Tenant | null) {
    return this.auth.forgotPassword(dto.email, tenant);
  }

  @Public() @Throttle(NORMAL) @HttpCode(200) @Post('reset-password')
  reset(@Body() dto: ResetPasswordDto, @CurrentTenant() tenant: Tenant | null) {
    return this.auth.resetPassword(dto.token, dto.password, tenant);
  }

  @Public() @Throttle(NORMAL) @HttpCode(200) @Post('verify-email')
  verifyEmail(@Body() dto: TokenDto, @CurrentTenant() tenant: Tenant | null) {
    return this.auth.verifyEmail(dto.token, tenant);
  }

  @Public() @Throttle(NORMAL) @HttpCode(200) @Post('accept-invite')
  acceptInvite(@Body() dto: AcceptInviteDto, @CurrentTenant() tenant: Tenant | null) {
    return this.auth.acceptInvite(dto.token, dto.password, dto.name, tenant);
  }

  // --- Logged in ------------------------------------------------------------

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @Patch('me')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: ProfileDto) {
    return this.auth.updateProfile(user, dto);
  }

  @Throttle(STRICT) @HttpCode(200) @Post('resend-verification')
  resendVerification(@CurrentUser() user: AuthUser) {
    return this.auth.resendVerification(user);
  }

  @Throttle(NORMAL) @HttpCode(200) @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user, dto.currentPassword, dto.newPassword);
  }

  @HttpCode(200) @Post('2fa/setup')
  twofaSetup(@CurrentUser() user: AuthUser) {
    return this.auth.twofaSetup(user);
  }

  @Throttle(NORMAL) @HttpCode(200) @Post('2fa/enable')
  twofaEnable(@CurrentUser() user: AuthUser, @Body() dto: CodeDto) {
    return this.auth.twofaEnable(user, dto.code);
  }

  @Throttle(NORMAL) @HttpCode(200) @Post('2fa/disable')
  twofaDisable(@CurrentUser() user: AuthUser, @Body() dto: PasswordDto) {
    return this.auth.twofaDisable(user, dto.password);
  }
}
