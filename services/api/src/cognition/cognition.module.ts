import { Module } from '@nestjs/common';
import { CognitionService } from './cognition.service';
import { CognitionConceptPort, CognitionMemoryStore, SynapsePersistence } from './cognition.store';

/**
 * The cognition runtime.
 *
 * `CognitionService` is exported because two callers legitimately need it and
 * neither is a read of operator data:
 *
 *  · `AdminModule` renders the console.
 *  · the assistant and the internal ingest route push percepts in.
 *
 * Nothing else should depend on it. In particular, no user-facing feature may
 * read a hypothesis or a proposal — the network's output is operator-facing by
 * construction, and a product surface that consumed it would be a path to a
 * user that bypasses every gate this platform has (ARCHITECTURE Rule 2).
 *
 * `PrismaModule` and `CommonModule` (which provides `LeaderElectionService`)
 * are both `@Global`, so neither is imported here.
 */
@Module({
  providers: [CognitionService, CognitionMemoryStore, CognitionConceptPort, SynapsePersistence],
  exports: [CognitionService],
})
export class CognitionModule {}
