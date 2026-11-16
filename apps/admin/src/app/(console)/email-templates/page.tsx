'use client';

import { useEffect, useState } from 'react';
import { admin, type EmailDeliveryRow, type EmailPreview, type EmailTemplateRow } from '@/lib/api';
import { Empty, Panel, Pill } from '@/components/ui';

/**
 * Email Templates — the console's view of the centralized template registry
 * (`services/api/src/mail/email-templates.ts`).
 *
 * Preview renders the real template with its fictional sample data (all
 * addresses are example.com). "Send test to me" goes ONLY to the signed-in
 * operator's own address: the API takes the recipient from the verified admin
 * identity, never from this page, and logs it as a test. There is no control
 * here that can email a customer.
 *
 * The HTML preview is shown in a sandboxed iframe with scripts disabled, so a
 * template can never execute anything in the console's origin.
 */
export default function EmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplateRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [view, setView] = useState<'html' | 'text'>('html');
  const [error, setError] = useState<string | null>(null);
  const [sendState, setSendState] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [deliveries, setDeliveries] = useState<EmailDeliveryRow[]>([]);

  useEffect(() => {
    admin
      .emailTemplates()
      .then((r) => {
        setTemplates(r.templates);
        setSelected((cur) => cur ?? r.templates[0]?.key ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load templates.'));
    admin.emailDeliveries().then((r) => setDeliveries(r.deliveries)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setPreview(null);
    setSendState(null);
    admin
      .emailPreview(selected)
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not render the preview.'));
  }, [selected]);

  const current = templates?.find((t) => t.key === selected) ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Email Templates</h1>
        <p className="text-[12px] text-muted">
          The {templates?.length ?? 15} branded emails the platform sends. Previews use sample data; test sends go only to you.
        </p>
      </div>
      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Panel title="Templates">
          {!templates ? (
            <Empty>Loading…</Empty>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {templates.map((t) => (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => setSelected(t.key)}
                    aria-current={t.key === selected}
                    className={`w-full px-4 py-2.5 text-left text-[12.5px] ${t.key === selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
                  >
                    <span className="font-semibold">{t.name}</span>
                    <span className="ml-2 text-[11px] text-muted">v{t.version}</span>
                    <span className="block text-[11px] text-muted">
                      7d: {Object.entries(t.last7Days).map(([s, n]) => `${n} ${s}`).join(', ') || 'none sent'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={current ? `${current.name} · v${current.version}` : 'Preview'}
          subtitle={current?.description}
          right={
            current && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setView(view === 'html' ? 'text' : 'html')}
                  className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] hover:bg-white/[0.05]"
                >
                  {view === 'html' ? 'Plain text' : 'HTML'}
                </button>
                <button
                  type="button"
                  disabled={sending}
                  onClick={async () => {
                    setSending(true);
                    setSendState(null);
                    try {
                      const r = await admin.emailTestSend(current.key);
                      setSendState(`Test ${r.status} → ${r.to}${r.error ? ` (${r.error})` : ''}`);
                      admin.emailDeliveries().then((d) => setDeliveries(d.deliveries)).catch(() => undefined);
                    } catch (e) {
                      setSendState(e instanceof Error ? e.message : 'Test send failed.');
                    } finally {
                      setSending(false);
                    }
                  }}
                  className="rounded-md bg-teal-500/90 px-2.5 py-1 text-[11.5px] font-semibold text-black hover:bg-teal-400 disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send test to me'}
                </button>
              </div>
            )
          }
        >
          <div className="space-y-3 p-4">
            {current && (
              <p className="text-[11.5px] text-muted">
                Placeholders: {current.placeholders.map((p) => `{{${p}}}`).join(' ') || 'none'}
              </p>
            )}
            {sendState && <p className="text-[12px]">{sendState}</p>}
            {!preview ? (
              <Empty>Rendering…</Empty>
            ) : (
              <>
                <p className="text-[12.5px]">
                  <span className="text-muted">Subject:</span> {preview.subject}
                </p>
                {view === 'html' ? (
                  <iframe
                    title={`${preview.key} preview`}
                    sandbox=""
                    srcDoc={preview.html}
                    className="h-[560px] w-full rounded-lg border border-white/10 bg-white"
                  />
                ) : (
                  <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-3 text-[12px]">
                    {preview.text}
                  </pre>
                )}
              </>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Recent deliveries" subtitle="Last 50 sends, recipients masked">
        {deliveries.length === 0 ? (
          <Empty>No emails sent yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Template</th>
                  <th className="px-4 py-2 font-medium">To</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Attempts</th>
                  <th className="px-4 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-1.5 text-muted">{new Date(d.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-1.5">
                      {d.templateKey} v{d.templateVersion} {d.isTest && <Pill tone="info">test</Pill>}
                    </td>
                    <td className="px-4 py-1.5 text-muted">{d.toAddress}</td>
                    <td className="px-4 py-1.5">
                      <Pill tone={d.status === 'sent' ? 'good' : d.status === 'failed' ? 'bad' : 'warn'}>{d.status}</Pill>
                    </td>
                    <td className="px-4 py-1.5">{d.attempts}</td>
                    <td className="max-w-[280px] truncate px-4 py-1.5 text-muted">{d.lastError ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
