import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { OtpService } from './otp.service';

@Module({ controllers: [AuthController], providers: [AuthService, AuthGuard, OtpService], exports: [AuthGuard, AuthService] })
export class AuthModule {}
