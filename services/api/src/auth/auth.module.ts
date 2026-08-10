import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { OtpService } from './otp.service';
import { GoogleOauthService } from './google-oauth.service';

@Module({ controllers: [AuthController], providers: [AuthService, AuthGuard, OtpService, GoogleOauthService], exports: [AuthGuard, AuthService] })
export class AuthModule {}
