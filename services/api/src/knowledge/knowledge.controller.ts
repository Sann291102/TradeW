import { Controller, Get, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import { Observable, interval, map, merge } from 'rxjs';
import { fromEvent } from 'rxjs';
import { AdminGuard } from '../admin/admin.guard';
import { KnowledgeWorkspaceGuard } from './knowledge.guard';
import { ActivityEvent, KnowledgeService } from './knowledge.service';

/**
 * Read-only REST + SSE surface over the knowledge vault (engineering docs —
 * architecture decisions, gotchas, agent research notes — not user data).
 *
 * Moved under `/admin/knowledge` on 2026-08-04, alongside the frontend's move
 * of this page from the public `/knowledge` route to `/admin/knowledge`
 * (2026-08-03). Until this change, the route stayed at `/knowledge` gated
 * only by `KnowledgeWorkspaceGuard` — a feature *toggle*, not authentication
 * — so once `KNOWLEDGE_WORKSPACE_ENABLED=true` (the non-production default),
 * the vault was reachable by an unauthenticated request. That contradicted
 * the frontend's own `lib/admin/knowledge.ts` comment, which believed this
 * route already required a bearer token; it never did.
 *
 * Two guards now compose deliberately:
 *  1. `KnowledgeWorkspaceGuard` — the existing kill switch. Still governs
 *     whether the surface exists at all (404s when disabled), independent of
 *     who's asking.
 *  2. `AdminGuard` — the same double factor (`isAdmin` JWT + operator token)
 *     every other `/admin/*` route requires. See `admin/admin.guard.ts`.
 *
 * The live change stream (`GET /admin/knowledge/stream`) is one of the two
 * SSE routes `AdminGuard` allows query-param credentials for, since
 * `EventSource` cannot set an Authorization header.
 */
@UseGuards(KnowledgeWorkspaceGuard, AdminGuard)
@Controller('admin/knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('tree')
  tree() {
    return this.knowledge.tree();
  }

  @Get('file')
  file(@Query('path') path: string) {
    return this.knowledge.file(path ?? '');
  }

  @Get('recent')
  recent(@Query('limit') limit?: string) {
    return this.knowledge.recent(limit ? Number(limit) : 20);
  }

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.knowledge.search(q ?? '', limit ? Number(limit) : 50);
  }

  @Get('graph')
  graph() {
    return this.knowledge.graph();
  }

  @Get('activity')
  activity(@Query('since') since?: string) {
    return this.knowledge.activity(since ? Number(since) : undefined);
  }

  /** Live change feed. Heartbeat keeps intermediaries from closing an idle stream. */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const changes = fromEvent(this.knowledge.changes, 'change').pipe(
      map((ev) => ({ type: 'change', data: ev as ActivityEvent }) as MessageEvent),
    );
    const heartbeat = interval(25_000).pipe(map(() => ({ type: 'ping', data: { at: Date.now() } }) as MessageEvent));
    return merge(changes, heartbeat);
  }
}
