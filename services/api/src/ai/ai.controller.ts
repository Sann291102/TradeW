import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { ConversationService } from './conversation/conversation.service';
import { OrchestratorService, type PageContext } from './orchestrator/orchestrator.service';
import { PersonaService } from './persona/persona.service';
import { SUGGESTED_NAMES, validatePersonaName } from './persona/persona-name.filter';

type AuthedRequest = { user: { sub: string; email?: string } };

/** Documentation models only — the handlers keep their inline types. */
class AskBody {
  @ApiProperty({ example: 'What is NIFTY doing today?' })
  text!: string;

  @ApiProperty({ required: false, enum: ['text', 'voice'], example: 'voice' })
  inputMode?: 'text' | 'voice';

  @ApiProperty({
    required: false,
    description: 'What the user is looking at, so deictic questions ("explain this") resolve.',
    example: { route: '/trade', symbol: 'NIFTY', timeframe: '15m', indicators: ['EMA20', 'VWAP'] },
  })
  pageContext?: PageContext;
}

class PersonaBody {
  @ApiProperty({ example: 'Nova', maxLength: 24 })
  name!: string;
}

/**
 * The assistant's HTTP surface.
 *
 * Everything except `/ai/persona/validate` and `/ai/persona/suggestions`
 * requires a bearer token. Those two are deliberately public because the
 * naming moment happens on the landing page BEFORE an account exists
 * (`AI-PERSONA.md` §2) — they read nothing and write nothing, so being
 * unauthenticated costs no user data.
 */
@ApiTags('TradeW AI')
@Controller('ai')
export class AiController {
  constructor(
    private readonly persona: PersonaService,
    private readonly conversations: ConversationService,
    private readonly orchestrator: OrchestratorService,
  ) {}

  // ------------------------------------------------------------------ persona

  @Get('persona/suggestions')
  @ApiOperation({ summary: 'House-invented name suggestions for the pre-signup naming moment.' })
  suggestions() {
    return { suggestions: SUGGESTED_NAMES };
  }

  @Post('persona/validate')
  @ApiOperation({
    summary: 'Validate a proposed name before signup.',
    description:
      'Stateless. The landing page calls this so a user is not told their name was rejected only after creating an account. This is a convenience, not the enforcement point — the same filter runs again on every write.',
  })
  @ApiBody({ type: PersonaBody })
  validate(@Body() body: { name?: unknown }) {
    const check = validatePersonaName(body?.name);
    return check.ok
      ? { ok: true, name: check.name }
      : { ok: false, ruleId: check.ruleId, message: check.message };
  }

  @Get('persona')
  @UseGuards(AuthGuard)
  @ApiBearerAuth(SECURITY.bearer)
  getPersona(@Req() req: AuthedRequest) {
    return this.persona.get(req.user.sub);
  }

  @Put('persona')
  @UseGuards(AuthGuard)
  @ApiBearerAuth(SECURITY.bearer)
  @ApiBody({ type: PersonaBody })
  setPersona(@Req() req: AuthedRequest, @Body() body: { name?: unknown }) {
    return this.persona.set(req.user.sub, body?.name);
  }

  // ---------------------------------------------------------------- assistant

  @Post('ask')
  @UseGuards(AuthGuard)
  @ApiBearerAuth(SECURITY.bearer)
  @ApiOperation({
    summary: 'Ask the assistant.',
    description:
      'Runs the full pipeline: understand, route, gather data, reason, compliance-gate, respond. Every response has passed the server-side advice boundary — including responses to requests that arrive here directly rather than through the UI.',
  })
  @ApiBody({ type: AskBody })
  async ask(@Req() req: AuthedRequest, @Body() body: { text?: unknown; inputMode?: unknown; pageContext?: unknown }) {
    const text = body?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new BadRequestException('text is required');
    }
    if (text.length > 4000) {
      throw new BadRequestException('text is too long (max 4000 characters)');
    }
    const inputMode = body?.inputMode === 'voice' ? 'voice' : 'text';

    return this.orchestrator.ask({
      userId: req.user.sub,
      text,
      inputMode,
      pageContext: sanitizePageContext(body?.pageContext),
    });
  }

  // ------------------------------------------------------------- conversation

  @Get('conversation')
  @UseGuards(AuthGuard)
  @ApiBearerAuth(SECURITY.bearer)
  @ApiOperation({ summary: "Today's thread, for restore on load. Null when the user hasn't spoken yet." })
  restore(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.conversations.restore(req.user.sub, clampLimit(limit, 50, 200));
  }

  @Get('conversations')
  @UseGuards(AuthGuard)
  @ApiBearerAuth(SECURITY.bearer)
  @ApiOperation({ summary: 'Archived threads, newest first.' })
  history(@Req() req: AuthedRequest, @Query('take') take?: string, @Query('skip') skip?: string) {
    return this.conversations.history(req.user.sub, clampLimit(take, 30, 100), clampLimit(skip, 0, 10_000));
  }

  @Get('conversations/:id/messages')
  @UseGuards(AuthGuard)
  @ApiBearerAuth(SECURITY.bearer)
  async messages(@Req() req: AuthedRequest, @Param('id') id: string, @Query('take') take?: string) {
    const messages = await this.conversations.messagesOf(req.user.sub, id, clampLimit(take, 200, 500));
    // Null means "not yours or not found" — deliberately indistinguishable, so
    // this cannot be used to discover which conversation ids exist.
    if (messages === null) return { messages: [] };
    return { messages };
  }
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Page context arrives from the browser and is echoed into a model prompt, so
 * it is shaped and length-capped here rather than trusted. Unknown keys are
 * dropped: the prompt should never carry a field the server does not
 * understand.
 */
function sanitizePageContext(raw: unknown): PageContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max = 64) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

  const indicators = Array.isArray(r.indicators)
    ? r.indicators.filter((i): i is string => typeof i === 'string').slice(0, 12).map((i) => i.slice(0, 32))
    : undefined;

  const ctx: PageContext = {
    route: str(r.route, 128),
    symbol: str(r.symbol, 32),
    timeframe: str(r.timeframe, 16),
    panel: str(r.panel, 48),
    ...(indicators?.length ? { indicators } : {}),
  };

  return Object.values(ctx).some((v) => v !== undefined) ? ctx : undefined;
}
