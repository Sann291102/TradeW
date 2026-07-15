import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

class AuthDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  experienceLevel?: string;

  @IsOptional()
  @IsString()
  optionsFamiliarity?: string;
}

class PreferenceDto {
  @IsObject()
  value!: Record<string, unknown>;
}

function meta(req: any) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  signup(@Req() req: any, @Body() dto: AuthDto) { return this.auth.signup(dto.email, dto.password, meta(req)); }

  @Post('login')
  login(@Req() req: any, @Body() dto: AuthDto) { return this.auth.login(dto.email, dto.password, meta(req)); }

  @Post('refresh')
  refresh(@Req() req: any, @Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken, meta(req)); }

  @UseGuards(AuthGuard)
  @Post('logout')
  logout(@Req() req: any, @Body() dto: Partial<RefreshDto>) { return this.auth.logout(req.user.sub, dto.refreshToken, meta(req)); }

  @UseGuards(AuthGuard)
  @Get('me')
  me(@Req() req: any) { return this.auth.me(req.user.sub); }

  @UseGuards(AuthGuard)
  @Patch('me')
  updateMe(@Req() req: any, @Body() dto: UpdateProfileDto) { return this.auth.updateMe(req.user.sub, dto, meta(req)); }

  @UseGuards(AuthGuard)
  @Get('preferences')
  preferences(@Req() req: any) { return this.auth.listPreferences(req.user.sub); }

  @UseGuards(AuthGuard)
  @Post('preferences/:key')
  setPreference(@Req() req: any, @Param('key') key: string, @Body() dto: PreferenceDto) {
    return this.auth.setPreference(req.user.sub, key, dto.value, meta(req));
  }
}
