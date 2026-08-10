import { Global, Module } from '@nestjs/common';
import { LeaderElectionService } from './leader-election';

/**
 * Cross-cutting infrastructure that is not a feature.
 *
 * `@Global` for the same reason `PrismaModule` is: leader election is consumed
 * by background loops that live inside feature modules (`sim`, `telemetry`),
 * and making each of those import a module to ask "should I run?" would put an
 * infrastructure dependency in every feature module's import list for no
 * benefit. There is exactly one instance per process, which is the point — two
 * `LeaderElectionService` instances would hold two leases under two holder ids
 * and defeat the whole mechanism.
 */
@Global()
@Module({
  providers: [LeaderElectionService],
  exports: [LeaderElectionService],
})
export class CommonModule {}
