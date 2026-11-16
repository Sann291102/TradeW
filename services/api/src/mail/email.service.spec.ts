import { describe, expect, it, vi } from 'vitest';
import { EmailService } from './email.service';
import type { MailService, SendResult } from './mail.service';
import type { PrismaService } from '../prisma/prisma.service';

function harness(results: SendResult[]) {
  const logs: Array<Record<string, unknown>> = [];
  const send = vi.fn(async () => results.shift() ?? { delivered: true });
  const prisma = {
    emailDeliveryLog: { create: async ({ data }: { data: Record<string, unknown> }) => (logs.push(data), { id: `log-${logs.length}` }) },
  } as unknown as PrismaService;
  const mail = { send, provider: 'smtp' } as unknown as MailService;
  return { svc: new EmailService(prisma, mail), send, logs };
}

const VARS = { FirstName: 'Asha' };

describe('EmailService.sendTemplate', () => {
  it('sends once and logs a delivered row with template key and version', async () => {
    const { svc, send, logs } = harness([{ delivered: true }]);
    const res = await svc.sendTemplate('welcome', 'asha@example.com', VARS, { userId: 'u1' });
    expect(res.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatchObject({ templateKey: 'welcome', templateVersion: 1, status: 'sent', attempts: 1, userId: 'u1', isTest: false });
  });

  it('retries a transient failure and succeeds', async () => {
    const { svc, send, logs } = harness([{ delivered: false, transient: true, error: 'ETIMEDOUT' }, { delivered: true }]);
    const res = await svc.sendTemplate('welcome', 'asha@example.com', VARS);
    expect(res.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(logs[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('gives up after three transient failures and logs the error', async () => {
    const t = { delivered: false, transient: true, error: '421 try later' };
    const { svc, send, logs } = harness([t, t, t]);
    const res = await svc.sendTemplate('welcome', 'asha@example.com', VARS);
    expect(res.delivered).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
    expect(logs[0]).toMatchObject({ status: 'failed', attempts: 3, lastError: '421 try later' });
  }, 10_000);

  it('does not retry a permanent failure', async () => {
    const { svc, send, logs } = harness([{ delivered: false, transient: false, error: '550 no such user' }]);
    await svc.sendTemplate('welcome', 'asha@example.com', VARS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('logs console mode as console and keeps the preview', async () => {
    const { svc, logs } = harness([{ delivered: false, preview: 'body' }]);
    const res = await svc.sendTemplate('welcome', 'asha@example.com', VARS);
    expect(res.preview).toBe('body');
    expect(logs[0]).toMatchObject({ status: 'console' });
  });

  it('never sends to synthetic phone-signup addresses', async () => {
    const { svc, send } = harness([]);
    await svc.sendTemplate('welcome', '919876543210@phone.tradew.local', VARS);
    expect(send).not.toHaveBeenCalled();
  });

  it('throws on a render error instead of sending a broken email', async () => {
    const { svc, send } = harness([]);
    await expect(svc.sendTemplate('verify_email', 'a@example.com', {})).rejects.toThrow(/needs a value/);
    expect(send).not.toHaveBeenCalled();
  });
});
