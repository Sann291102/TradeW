import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AssistantService } from './assistant.service';
import { ServiceTokenGuard } from '../service-token.guard';

interface InterpretBody {
  utterance?: unknown;
  context?: unknown;
  userId?: unknown;
}

/**
 * The internal surface of the TradeW AI runtime.
 *
 * Every route is behind `ServiceTokenGuard` except `/health`, which exists for
 * container probes and deliberately reveals nothing beyond liveness and whether
 * a provider is configured. `apps/web` never calls any of this — the only
 * caller is `services/api` (ARCHITECTURE.md §1).
 */
@Controller()
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('health')
  health() {
    return {
      ok: true,
      service: 'tradew-ai',
      // Reported so `services/api` can degrade gracefully rather than
      // discovering an unconfigured brain one 503 at a time.
      brain: this.assistant.isAvailable() ? 'ready' : 'unconfigured',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Utterance + workspace context → a validated plan.
   *
   * Note what this does NOT accept: a system prompt, a model name, a tool list,
   * or anything else that would let the caller reshape the agent. The roster is
   * declarative and version-controlled; a request selects an agent, it does not
   * define one.
   */
  @UseGuards(ServiceTokenGuard)
  @Post('assistant/interpret')
  async interpret(@Body() body: InterpretBody) {
    const utterance = typeof body.utterance === 'string' ? body.utterance.trim() : '';
    if (!utterance) {
      return {
        goal: '',
        steps: [],
        needsAnalysis: false,
        unsupported: 'No request was provided.',
        dropped: 0,
        model: 'unavailable' as const,
      };
    }

    return this.assistant.interpret({
      // Bounded before it reaches the model: an unbounded utterance is an
      // unbounded bill, and nothing legitimate needs more than this.
      utterance: utterance.slice(0, 2000),
      context:
        body.context && typeof body.context === 'object'
          ? (body.context as Record<string, unknown>)
          : undefined,
      userId: typeof body.userId === 'string' ? body.userId : null,
    });
  }
}
