import { describe, expect, it, vi } from 'vitest';
import { ComplianceGate } from './compliance.gate';
import { evaluateCompliance } from './compliance.rules';

/**
 * The gate's own behaviour, as distinct from the rules it applies:
 * substitution, fail-closed, and the self-reference trap.
 */

describe('ComplianceGate.guard', () => {
  it('passes clean market commentary through unchanged', () => {
    const gate = new ComplianceGate();
    const text = 'NIFTY is holding above 24,300 with support tested three times this week.';
    const result = gate.guard(text);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(text);
    expect(result.verdict.decision).toBe('allow');
  });

  it('substitutes the refusal for advice and never returns the original', () => {
    const gate = new ComplianceGate();
    const advice = 'You should buy RELIANCE at 1400 with a stop-loss at 1380.';
    const result = gate.guard(advice);
    expect(result.blocked).toBe(true);
    expect(result.text).toBe(ComplianceGate.BLOCKED_REPLY);
    expect(result.text).not.toContain('1400');
  });

  it('records which rules fired so the block is auditable', () => {
    const gate = new ComplianceGate();
    const result = gate.guard('Buy NIFTY. Target of 25000.');
    expect(result.verdict.findings.map((f) => f.ruleId)).toContain('advice.imperative');
    expect(result.verdict.findings.map((f) => f.ruleId)).toContain('advice.target');
  });
});

describe('the self-reference trap', () => {
  /**
   * The substituted refusal must itself pass the gate. If it does not, a
   * blocked response either recurses or fails closed permanently — and every
   * boundary-probing question returns an error instead of a clean refusal.
   */
  it('BLOCKED_REPLY evaluates to allow', () => {
    expect(evaluateCompliance(ComplianceGate.BLOCKED_REPLY).decision).toBe('allow');
  });

  it('guarding the refusal is idempotent', () => {
    const gate = new ComplianceGate();
    const once = gate.guard(ComplianceGate.BLOCKED_REPLY);
    expect(once.blocked).toBe(false);
    expect(once.text).toBe(ComplianceGate.BLOCKED_REPLY);
  });
});

describe('fail-closed', () => {
  it('blocks when evaluation throws', async () => {
    const gate = new ComplianceGate();
    // Force an internal failure the way a real one would arrive: a value that
    // explodes when the evaluator touches it.
    const hostile = {
      normalize() {
        throw new Error('boom');
      },
      toString() {
        throw new Error('boom');
      },
    } as unknown as string;

    const result = gate.guard(hostile);
    expect(result.blocked).toBe(true);
    expect(result.verdict.decision).toBe('block');
    expect(result.verdict.failedClosed).toBe(true);
    expect(result.text).toBe(ComplianceGate.BLOCKED_REPLY);
  });

  it('a failed evaluation still produces a storable verdict', () => {
    const gate = new ComplianceGate();
    const hostile = {
      normalize() {
        throw new Error('boom');
      },
    } as unknown as string;
    const verdict = gate.evaluate(hostile);
    expect(verdict.gateVersion).toBeTruthy();
    expect(verdict.error).toContain('boom');
    expect(() => JSON.stringify(verdict)).not.toThrow();
  });

  it('evaluate never throws, whatever it is handed', () => {
    const gate = new ComplianceGate();
    const nasties: unknown[] = [null, undefined, 0, {}, [], Symbol('x')];
    for (const n of nasties) {
      expect(() => gate.evaluate(n as string)).not.toThrow();
    }
  });
});

describe('logging', () => {
  it('logs a block with its rule ids', () => {
    const gate = new ComplianceGate();
    const warn = vi.spyOn((gate as unknown as { log: { warn: (m: string) => void } }).log, 'warn');
    gate.guard('You should sell everything.');
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('advice.');
  });
});
