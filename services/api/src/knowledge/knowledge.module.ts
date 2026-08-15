import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { AdminAccessGuard } from '../admin/admin-access.guard';
import { OperatorService } from '../admin/operator/operator.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeWorkspaceGuard } from './knowledge.guard';
import { KnowledgeService } from './knowledge.service';

/**
 * Knowledge Workspace module — a read-only, filesystem-backed view over the
 * TradeW/knowledge/ Obsidian vault. No database, no writes; markdown on disk
 * stays the single source of truth.
 *
 * The admin gate is re-provided here (not imported via `AdminModule`, which
 * deliberately exports nothing — see its own doc comment) so this module can
 * apply the identical double-gate without depending on the admin module. This
 * surface uses the SAME composed `AdminAccessGuard` as `AdminController`, so the
 * standalone operator console (which presents an operator assertion, not a
 * product JWT) can reach the vault too — otherwise the console's knowledge page
 * would 401 while the rest of it worked. `AdminAccessGuard` needs `AdminGuard`
 * (the product-admin path it delegates to) and `OperatorService`; both are
 * listed here, and their own deps (`JwtService`, `PrismaService`) are global.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeWorkspaceGuard, AdminGuard, OperatorService, AdminAccessGuard],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
