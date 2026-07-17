import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeWorkspaceGuard } from './knowledge.guard';
import { KnowledgeService } from './knowledge.service';

/**
 * Knowledge Workspace module — a read-only, filesystem-backed view over the
 * TradeW/knowledge/ Obsidian vault. No database, no writes; markdown on disk
 * stays the single source of truth.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeWorkspaceGuard],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
