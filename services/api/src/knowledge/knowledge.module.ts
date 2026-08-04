import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeWorkspaceGuard } from './knowledge.guard';
import { KnowledgeService } from './knowledge.service';

/**
 * Knowledge Workspace module — a read-only, filesystem-backed view over the
 * TradeW/knowledge/ Obsidian vault. No database, no writes; markdown on disk
 * stays the single source of truth.
 *
 * `AdminGuard` is re-provided here (not imported via `AdminModule`, which
 * deliberately exports nothing — see its own doc comment) so this module can
 * apply the identical admin double-gate without creating a dependency on the
 * admin module itself. `JwtService`/`PrismaService`, which the guard needs,
 * are both global providers already.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeWorkspaceGuard, AdminGuard],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
