import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  SYSTEM_CONTROL_KEY,
  SystemExecutionControlService,
  evaluateSystemControl,
} from './system-execution-control.service';

describe('evaluateSystemControl (pure gate)', () => {
  it('ON permits new entries and does not force square-off', () => {
    expect(evaluateSystemControl('ON')).toEqual({ mode: 'ON', allowNewEntries: true, forceSquareOff: false });
  });

  it('OFF blocks new entries but leaves scheduled square-off alone', () => {
    expect(evaluateSystemControl('OFF')).toEqual({ mode: 'OFF', allowNewEntries: false, forceSquareOff: false });
  });

  it('EMERGENCY_STOP blocks new entries AND forces square-off', () => {
    expect(evaluateSystemControl('EMERGENCY_STOP')).toEqual({
      mode: 'EMERGENCY_STOP',
      allowNewEntries: false,
      forceSquareOff: true,
    });
  });

  it('never permits a new entry in any non-ON mode', () => {
    for (const mode of ['OFF', 'EMERGENCY_STOP'] as const) {
      expect(evaluateSystemControl(mode).allowNewEntries).toBe(false);
    }
  });
});

/** Minimal fake for the two Prisma surfaces the service touches. */
function fakePrisma(overrides: Partial<Record<string, unknown>> = {}) {
  const auditCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    systemExecutionControl: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    auditEvent: { create: auditCreate },
    // setMode runs its upsert + audit inside a transaction; run the callback
    // against this same fake so both writes are observed.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    ...overrides,
  } as unknown as PrismaService & Record<string, { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> }>;
  return prisma;
}

describe('SystemExecutionControlService', () => {
  it('reads the default ON state when no row exists, flagged isDefault', async () => {
    const prisma = fakePrisma();
    const svc = new SystemExecutionControlService(prisma);
    const state = await svc.current();
    expect(state).toMatchObject({ mode: 'ON', isDefault: true, updatedAt: null });
    expect(prisma.systemExecutionControl.findUnique).toHaveBeenCalledWith({ where: { key: SYSTEM_CONTROL_KEY } });
  });

  it('reflects a stored EMERGENCY_STOP row and is not flagged default', async () => {
    const at = new Date('2026-08-26T09:25:00Z');
    const prisma = fakePrisma();
    (prisma.systemExecutionControl.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: SYSTEM_CONTROL_KEY,
      mode: 'EMERGENCY_STOP',
      reason: 'RBI statement',
      updatedBy: 'ops@tradew',
      updatedAt: at,
      createdAt: at,
    });
    const svc = new SystemExecutionControlService(prisma);
    const state = await svc.current();
    expect(state).toEqual({
      mode: 'EMERGENCY_STOP',
      reason: 'RBI statement',
      updatedBy: 'ops@tradew',
      updatedAt: at.toISOString(),
      isDefault: false,
    });
  });

  it('gate() maps the stored mode through the pure evaluator', async () => {
    const prisma = fakePrisma();
    (prisma.systemExecutionControl.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: SYSTEM_CONTROL_KEY,
      mode: 'OFF',
      reason: null,
      updatedBy: null,
      updatedAt: new Date(),
      createdAt: new Date(),
    });
    const svc = new SystemExecutionControlService(prisma);
    expect(await svc.gate()).toEqual({ mode: 'OFF', allowNewEntries: false, forceSquareOff: false });
  });

  it('fails CLOSED — a database read error yields no-new-entries, not "keep trading"', async () => {
    const prisma = fakePrisma();
    (prisma.systemExecutionControl.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const svc = new SystemExecutionControlService(prisma);
    const gate = await svc.gate();
    expect(gate.allowNewEntries).toBe(false);
    expect(gate.forceSquareOff).toBe(false);
  });

  it('setMode upserts the singleton and writes an audit event in the same transaction', async () => {
    const at = new Date('2026-08-26T09:26:00Z');
    const prisma = fakePrisma();
    (prisma.systemExecutionControl.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: SYSTEM_CONTROL_KEY,
      mode: 'EMERGENCY_STOP',
      reason: 'flatten now',
      updatedBy: 'ops@tradew',
      updatedAt: at,
      createdAt: at,
    });
    const svc = new SystemExecutionControlService(prisma);
    const state = await svc.setMode('EMERGENCY_STOP', 'ops@tradew', 'flatten now');

    expect(state).toMatchObject({ mode: 'EMERGENCY_STOP', reason: 'flatten now', updatedBy: 'ops@tradew' });
    expect(prisma.systemExecutionControl.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: SYSTEM_CONTROL_KEY } }),
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'execution.system-control.set',
          metadata: expect.objectContaining({ mode: 'EMERGENCY_STOP', operator: 'ops@tradew' }),
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });
});
