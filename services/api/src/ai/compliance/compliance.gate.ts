import { Injectable, Logger } from '@nestjs/common';
import {
  ComplianceVerdict,
  GATE_VERSION,
  evaluateCompliance,
} from './compliance.rules';

/**
 * The server-side advice boundary (`TRADEW-ASSISTANT.md` §11).
 *
 * Every assistant-authored string leaves the server through `guard()`. Nothing
 * else may write assistant text into a response — that single choke point is
 * what makes "observation, never advice" an architectural property rather than
 * a hope about prompt adherence (`TRADEW-OS.md` §1).
 *
 * ## Fail-closed
 *
 * If evaluation cannot complete, the answer is withheld. Availability is not
 * the value being protected: a user who sees "I couldn't produce that safely"
 * has lost a response, whereas a user who sees an unchecked one may have been
 * given a trade instruction the platform is not permitted to give. The
 * `try/catch` here is therefore not defensive boilerplate — the `catch` branch
 * is a deliberate product decision, and it is tested.
 *
 * ## Where the boundary is NOT
 *
 * `apps/web/src/lib/assistant/domain-guard.ts` also refuses advice-shaped
 * requests, but it runs in the browser on the REQUEST path: bypassable with
 * curl, and blind to model output. It stays as fast local feedback. This is
 * the enforcement point.
 */
@Injectable()
export class ComplianceGate {
  private readonly log = new Logger(ComplianceGate.name);

  /**
   * The response substituted whenever the gate blocks.
   *
   * Deliberately written to pass the gate itself — refusal copy necessarily
   * contains the words it refuses to act on, and a substitute that tripped the
   * rules would recurse or fail closed forever. `compliance.gate.spec.ts`
   * asserts this text evaluates to `allow`.
   */
  static readonly BLOCKED_REPLY =
    "I can't answer that the way it was asked. I explain what the market is " +
    'doing — structure, levels, positioning, volatility, news context — but I ' +
    "don't give trade calls, entries, exits, targets or stop-losses. Ask me " +
    'what a level means or why something moved, and I can go deep on it.';

  /** Evaluate text. Never throws; a failure is a `block` with `failedClosed`. */
  evaluate(text: string): ComplianceVerdict {
    try {
      return evaluateCompliance(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Logged at error, not warn: the gate failing is an incident, even
      // though the user-visible outcome is safe.
      this.log.error(`compliance evaluation failed, blocking: ${message}`);
      return {
        decision: 'block',
        findings: [],
        gateVersion: GATE_VERSION,
        evaluatedAt: new Date().toISOString(),
        failedClosed: true,
        error: message,
      };
    }
  }

  /**
   * Evaluate, and return the text that may actually be sent.
   *
   * Callers must use `text` from the result rather than the string they passed
   * in — that is the whole point of routing through here.
   */
  guard(text: string): { text: string; verdict: ComplianceVerdict; blocked: boolean } {
    const verdict = this.evaluate(text);
    const blocked = verdict.decision === 'block';
    if (blocked) {
      this.log.warn(
        `blocked assistant output [${verdict.findings.map((f) => f.ruleId).join(', ') || 'fail-closed'}]`,
      );
    }
    return {
      text: blocked ? ComplianceGate.BLOCKED_REPLY : text,
      verdict,
      blocked,
    };
  }
}
