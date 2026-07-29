import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DhanAuthController } from './dhan-auth.controller';
import { DhanAuthService } from './dhan-auth.service';

/**
 * Broker connections. Dhan today; a second broker would add a service here
 * rather than a parallel module, since BrokerCredential is keyed by
 * (provider, userId).
 *
 * Exports DhanAuthService so the feed bridge can be given the live token
 * without every consumer reaching into BrokerCredential directly — which also
 * means the `isFeedDefault` designation is enforced in one place rather than at
 * each caller.
 *
 * The routes here are gated by `AuthGuard` (and `AdminTokenGuard` for operator
 * actions). `AuthGuard` injects `JwtService`, which resolves from the
 * `JwtModule.register({ global: true })` in `app.module.ts` — deliberately NOT
 * re-registered locally, since a second registration would be a second place for
 * the signing config to drift from the one that issues the tokens.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DhanAuthController],
  providers: [DhanAuthService],
  exports: [DhanAuthService],
})
export class BrokerModule {}
