import { Controller, Get, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import { Observable, interval, map, merge } from 'rxjs';
import { fromEvent } from 'rxjs';
import { KnowledgeWorkspaceGuard } from './knowledge.guard';
import { ActivityEvent, KnowledgeService } from './knowledge.service';

/**
 * Read-only REST + SSE surface over the knowledge vault.
 *
 * Gated solely by KnowledgeWorkspaceGuard — an internal developer tool that
 * serves engineering docs (no user data) and is off by default in production
 * (KNOWLEDGE_WORKSPACE_ENABLED). It deliberately does NOT require a per-user
 * JWT: the whole point is a frictionless in-app view of the vault without a
 * login/database round-trip, and the browser EventSource used by the live
 * stream can't attach an Authorization header anyway. If this surface is ever
 * enabled in production, put it behind the ingress/network auth there — do not
 * rely on this controller for user authentication.
 */
@UseGuards(KnowledgeWorkspaceGuard)
@Controller('knowledge')
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
