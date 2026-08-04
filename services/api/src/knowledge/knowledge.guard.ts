import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

/**
 * Feature toggle for the whole Knowledge Workspace surface — whether it
 * exists at all, independent of who's asking:
 *
 *   KNOWLEDGE_WORKSPACE_ENABLED=true   -> always on
 *   KNOWLEDGE_WORKSPACE_ENABLED=false  -> always off
 *   unset                              -> on outside production, off in production
 *
 * Off returns 404 (not 403) so the surface isn't advertised when disabled.
 *
 * This is NOT an authentication check. `KnowledgeController` composes this
 * guard with `AdminGuard` (`@UseGuards(KnowledgeWorkspaceGuard, AdminGuard)`)
 * — this one decides IF the route exists, `AdminGuard` decides WHO may call
 * it. Before 2026-08-04 this guard was the only one on the controller, which
 * meant an enabled deployment had no authentication on the vault at all.
 */
@Injectable()
export class KnowledgeWorkspaceGuard implements CanActivate {
  canActivate(): boolean {
    const flag = process.env.KNOWLEDGE_WORKSPACE_ENABLED;
    const enabled = flag === 'true' || (flag !== 'false' && process.env.NODE_ENV !== 'production');
    if (!enabled) throw new NotFoundException();
    return true;
  }
}
