import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EXPENSIVE_LIMIT } from '../common/throttling';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { AssistantApiService } from './assistant.service';

type AuthedRequest = { user: { sub: string } };

/**
 * DOCUMENTATION MODEL ONLY — same convention as `sentinel.controller.ts`: the
 * handler keeps its inline `@Body()` type so the global ValidationPipe skips
 * it, and this class exists to give the generated reference a real schema.
 */
class InterpretBody {
  @ApiProperty({ example: 'take me to my journal', description: 'What the user said or typed.' })
  utterance!: string;

  @ApiProperty({
    required: false,
    type: Object,
    description:
      'Read-only workspace context (active route, selected symbol, visible panels). Never contains credentials or positions.',
  })
  context?: Record<string, unknown>;
}

@ApiTags('assistant')
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantApiService) {}

  /**
   * Natural-language request → an ordered plan of application actions.
   *
   * Reached only when the deterministic resolver in `apps/web` could not
   * understand the request (AI-OPERATING-SYSTEM.md §3), so this is the
   * expensive path by construction and is throttled as such.
   *
   * **Not entitlement-gated.** Deliberate, and worth stating because the
   * neighbouring Sentinel routes are: understanding "open my portfolio" is
   * basic operation of the application the user already paid nothing for, and
   * putting the ability to *navigate by voice* behind a plan would make the
   * accessibility story a paid feature. The runtime it calls cannot reach
   * Sentinel's reasoning, market analysis, or any order path, so there is no
   * premium capability behind this door to protect.
   */
  @ApiBearerAuth(SECURITY.bearer)
  @ApiBody({ type: InterpretBody })
  @ApiResponse({ status: 201, description: 'A validated plan. `steps` may be empty.' })
  @ApiResponse({ status: 503, description: 'The assistant runtime is down or unconfigured.' })
  @Throttle(EXPENSIVE_LIMIT)
  @UseGuards(AuthGuard)
  @Post('interpret')
  async interpret(
    @Req() req: AuthedRequest,
    @Body() body: { utterance?: string; context?: Record<string, unknown> },
  ) {
    const utterance = typeof body?.utterance === 'string' ? body.utterance.trim() : '';
    if (!utterance) {
      return { goal: '', steps: [], needsAnalysis: false, unsupported: 'Nothing to interpret.', dropped: 0 };
    }
    return this.assistant.interpret(req.user.sub, utterance.slice(0, 2000), body?.context);
  }
}
