import { Controller, Get, NotFoundException, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminAccessGuard } from '../admin/admin-access.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { GraphEventsService } from './graph.events';
import { GraphService } from './graph.service';
import {
  GRAPH_DOMAINS,
  GraphDomain,
  GraphFilter,
  NODE_KINDS,
  NodeKind,
  RELATION_TYPES,
  RelationType,
} from './graph.types';

interface StreamRequest {
  on(event: 'close', listener: () => void): void;
}
interface StreamResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
}

/**
 * The system graph's read surface.
 *
 * Operator-gated by the same double factor as the rest of `/admin/*` — see
 * `AdminAccessGuard`. That is not a formality here: this graph names every
 * route the API serves, which of them are unguarded, which background loops
 * hold a lease and which execution profiles are armed. It is a map of the
 * attack surface as much as a map of the system, and the two audiences are the
 * same people.
 *
 * Nothing on this surface writes. The visualisation is never the source of
 * truth — it is a read of state the platform already persisted, and there is
 * deliberately no endpoint here through which a console could pin, hide or
 * delete a node. Historical knowledge and relationships are owned by the
 * tables that hold them, and this module has no reason to be able to erase one.
 */
@ApiTags('Admin System Graph')
@ApiSecurity({ [SECURITY.bearer]: [], [SECURITY.adminToken]: [] })
@UseGuards(AdminAccessGuard)
@Controller('admin/graph')
export class GraphController {
  constructor(
    private readonly graph: GraphService,
    private readonly events: GraphEventsService,
  ) {}

  /** The legend, the vocabulary, the counts and the published visual contract. */
  @Get('meta')
  meta() {
    return this.graph.meta();
  }

  /** First paint: domain combos and the graph's real hubs. */
  @Get('overview')
  overview(@Query() query: Record<string, string>) {
    return this.graph.overview(parseFilter(query));
  }

  /** A filtered slice. Every filter is applied server-side. */
  @Get('nodes')
  nodes(@Query() query: Record<string, string>) {
    return this.graph.query(parseFilter(query));
  }

  /**
   * Expand outward from one or more nodes — the click-to-expand path.
   *
   * `ids` is comma-separated so a multi-selection expands in one round trip
   * rather than N, which is what keeps a rubber-band selection of forty nodes
   * from becoming forty requests.
   */
  @Get('neighborhood')
  neighborhood(@Query('ids') ids: string, @Query('depth') depth: string, @Query() query: Record<string, string>) {
    const seeds = (ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 40);
    return this.graph.neighborhood(seeds, Number(depth) || 1, parseFilter(query));
  }

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit: string, @Query() query: Record<string, string>) {
    return this.graph.search(q ?? '', Number(limit) || 25, parseFilter(query));
  }

  /** Everything the inspector renders for one node. */
  @Get('node')
  async node(@Query('id') id: string) {
    const detail = await this.graph.node(id ?? '');
    if (!detail) throw new NotFoundException(`No node "${id}" in the current graph snapshot.`);
    return detail;
  }

  @Get('clusters')
  clusters(@Query() query: Record<string, string>) {
    return this.graph.clusters(parseFilter(query));
  }

  /**
   * A real signal path, reconstructed from a correlation id.
   *
   * With neither parameter it returns the most recent path the telemetry
   * tables can produce, which is what the console shows when nobody has picked
   * a request yet. `null` — not a fabricated example — when there is no traffic.
   */
  @Get('path')
  path(@Query('requestId') requestId?: string, @Query('runId') runId?: string) {
    if (!requestId && !runId) return this.graph.latestPath();
    return this.graph.path({ requestId, runId });
  }

  /** Events the console missed before it connected. */
  @Get('events')
  recentEvents(@Query('limit') limit?: string) {
    return this.events.recent(Number(limit) || 40);
  }

  /**
   * The live stream both visualisations subscribe to.
   *
   * Written against the raw response rather than `@Sse()` for the same reason
   * `GET /admin/stream` is — see the note there. A leaked listener on this bus
   * accumulates once per console reload for the life of the process, and this
   * bus is attached to the API's request path.
   */
  @ApiExcludeEndpoint()
  @Get('stream')
  stream(@Req() req: StreamRequest, @Res() res: StreamResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client vanished mid-write; the close handler cleans up */
      }
    };

    send('hello', { at: Date.now() });
    // Replay first, so a console that connects into a quiet minute still has
    // the last few real events to render rather than an empty feed.
    for (const event of this.events.recent(25)) send('graph', event);

    const onGraph = (event: unknown) => send('graph', event);
    this.events.bus.on('graph', onGraph);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.events.bus.off('graph', onGraph);
      res.end();
    });
  }
}

/**
 * Parse the filter query string.
 *
 * Every list is validated against its closed vocabulary and unknown members
 * are DROPPED rather than rejected: a console on an older build asking for a
 * node kind this deployment does not have should get the rest of its filter
 * honoured, not a 400 that blanks the page. Numeric bounds are clamped rather
 * than trusted, so `limit=1e9` costs nothing.
 */
export function parseFilter(query: Record<string, string>): GraphFilter {
  const list = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

  const num = (value: string | undefined, min: number, max: number): number | undefined => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(max, Math.max(min, parsed));
  };

  const tier = num(query.maxTier, 0, 2);

  return {
    domains: list(query.domains).filter((value): value is GraphDomain => (GRAPH_DOMAINS as readonly string[]).includes(value)),
    kinds: list(query.kinds).filter((value): value is NodeKind => (NODE_KINDS as readonly string[]).includes(value)),
    relations: list(query.relations).filter((value): value is RelationType => RELATION_TYPES.includes(value as RelationType)),
    sinceHours: num(query.sinceHours, 0.05, 24 * 365),
    minConfidence: num(query.minConfidence, 0, 1),
    minImportance: num(query.minImportance, 0, 1),
    minActivity: num(query.minActivity, 0, 1),
    q: query.q?.trim() || undefined,
    maxTier: tier === undefined ? undefined : (Math.round(tier) as 0 | 1 | 2),
    limit: num(query.limit, 1, 900),
  };
}
