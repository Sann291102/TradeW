import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { OtpService } from './otp.service';
import { GoogleOauthService } from './google-oauth.service';
import { AiModule } from '../ai/ai.module';

/**
 * `AiModule` is imported for `PersonaService` only: signup carries the name
 * the user chose on the landing page onto the new account (`AI-PERSONA.md`
 * §2). The dependency runs auth -> ai and never the other way, so there is no
 * cycle — `AiModule` guards its routes with `AuthGuard`, which is a class
 * import, not a module one.
 */
@Module({
  imports: [AiModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, OtpService, GoogleOauthService],
  exports: [AuthGuard, AuthService],
})
export class AuthModule {}
