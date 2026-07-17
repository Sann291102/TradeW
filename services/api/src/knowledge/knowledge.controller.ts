import { Controller, Get, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import { Observable, interval, map, merge } from 'rxjs';
import { fromEvent } from 'rxjs';
import { AuthGuard } from '../auth/auth.guard';
import { KnowledgeWorkspaceGuard } from './knowledge.guard';
import { ActivityEvent, KnowledgeService } from './knowledge.service';

/**
 * Read-only REST + SSE surface over the knowledge vault.
 *
 * The whole controller is dev-gated by KnowledgeWorkspaceGuard. Content
 * endpoints additionally require a normal user JWT (AuthGuard), matching the
 * rest of services/api. The SSE stream is dev-gated only — the browser
 * EventSource API can't attach an Authorization header — and it emits only
 * change metadata (path/type/title/timestamp), never file contents; the
 * client re-fetches the actual content through the authed endpoints.
 */
@UseGuards(KnowledgeWorkspaceGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @UseGuards(AuthGuard)
  @Get('tree')
  tree() {
    return this.knowledge.tree();
  }

  @UseGuards(AuthGuard)
  @Get('file')
  file(@Query('path') path: string) {
    return this.knowledge.file(path ?? '');
  }

  @UseGuards(AuthGuard)
  @Get('recent')
  recent(@Query('limit') limit?: string) {
    return this.knowledge.recent(limit ? Number(limit) : 20);
  }

  @UseGuards(AuthGuard)
  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.knowledge.search(q ?? '', limit ? Number(limit) : 50);
  }

  @UseGuards(AuthGuard)
  @Get('graph')
  graph() {
    return this.knowledge.graph();
  }

  @UseGuards(AuthGuard)
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
