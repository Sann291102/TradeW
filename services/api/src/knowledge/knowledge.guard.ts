import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

/**
 * Gates the whole Knowledge Workspace surface. It's an internal developer tool
 * that reads engineering docs off the server filesystem, so it must never be
 * silently reachable in production:
 *
 *   KNOWLEDGE_WORKSPACE_ENABLED=true   -> always on
 *   KNOWLEDGE_WORKSPACE_ENABLED=false  -> always off
 *   unset                              -> on outside production, off in production
 *
 * Off returns 404 (not 403) so the surface isn't advertised when disabled.
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
