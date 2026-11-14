import { existsSync, readFileSync } from 'node:fs';
import { SEVERITY } from './findings.mjs';

const ICON = { pass: '✅', finding: '🟠', blocked: '⚪', 'not-reached': '⏭️' };

/** Compare this run's finding ids with the previous run's: new / still open / fixed. */
export function compareWithPrevious(previousPath, findings, personaNames) {
  if (!existsSync(previousPath)) return { previousRun: null, new: findings.map((f) => f.id), still: [], fixed: [] };
  const prev = JSON.parse(readFileSync(previousPath, 'utf8'));
  // Only compare personas that ran this time: a one-persona run must not
  // report every other persona's findings as "fixed".
  const prevFindings = prev.findings.filter((f) => personaNames.includes(f.persona));
  const before = new Set(prevFindings.map((f) => f.id));
  const now = new Set(findings.map((f) => f.id));
  return {
    previousRun: prev.run.id,
    new: [...now].filter((id) => !before.has(id)),
    still: [...now].filter((id) => before.has(id)),
    fixed: prevFindings.filter((f) => !now.has(f.id)).map((f) => ({ id: f.id, message: f.message })),
  };
}

export function renderReport({ run, steps, findings, environment, trend, personas }) {
  const L = [];
  const count = (s) => steps.filter((x) => x.status === s).length;
  L.push(`# Virtual customer report — ${run.stamp.ist}`);
  L.push('');
  L.push(`Run \`${run.id}\` · ${run.stamp.session} · app ${run.baseUrl}`);
  L.push('');
  L.push(`**${steps.length} steps** — ✅ ${count('pass')} passed · 🟠 ${count('finding')} with product findings · ⚪ ${count('blocked')} blocked by the environment · ⏭️ ${count('not-reached')} not reached`);
  L.push('');
  L.push('> ⚪ **blocked** means the step could not run here (for example, no live market feed). It is not a pass and it is not a product bug.');
  L.push('> The "review" in this report is rule-based: scripted expectations plus what the observer saw. It is not an LLM opinion.');
  L.push('');

  if (trend) {
    L.push('## Since the last run');
    L.push('');
    if (!trend.previousRun) L.push('First recorded run — nothing to compare against.');
    else {
      L.push(`Compared with \`${trend.previousRun}\`: **${trend.new.length} new**, **${trend.still.length} still open**, **${trend.fixed.length} fixed**.`);
      for (const f of trend.fixed) L.push(`- ✔ fixed: ${f.message.slice(0, 120)} (\`${f.id}\`)`);
    }
    L.push('');
  }

  L.push('## Product findings');
  L.push('');
  if (findings.length === 0) L.push('None in the steps that could run.');
  for (const sev of ['S1', 'S2', 'S3']) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    L.push(`### ${sev} — ${SEVERITY[sev]}`);
    L.push('');
    for (const f of group) {
      const tag = trend?.new?.includes(f.id) ? ' 🆕' : trend?.still?.includes(f.id) ? ' (still open)' : '';
      L.push(`**\`${f.id}\` ${f.persona} · \`${f.route ?? ''}\` · ${f.step}**${tag}`);
      L.push(`- Kind: ${f.kind}`);
      L.push(`- Expected: ${f.expected}`);
      L.push(`- Actual: ${f.actual}`);
      if (f.screenshot) L.push(`- Screenshot: \`${f.screenshot}\``);
      L.push('');
    }
  }

  L.push('## Blocked by the environment');
  L.push('');
  if (environment.length === 0) L.push('Nothing was blocked.');
  for (const e of environment) {
    L.push(`- **${e.persona} · ${e.step}** — ${e.reason}`);
  }
  L.push('');

  L.push('## Every step');
  L.push('');
  for (const p of personas) {
    L.push(`### ${p.title}`);
    L.push('');
    L.push('| | Step | Route | Result |');
    L.push('|---|---|---|---|');
    for (const s of steps.filter((x) => x.persona === p.name)) {
      const detail =
        s.status === 'pass'
          ? ''
          : s.status === 'blocked' || s.status === 'not-reached'
            ? (s.environmentReason ?? '').replace(/\|/g, '\\|').slice(0, 140)
            : s.findings.map((f) => f.message).join('; ').replace(/\|/g, '\\|').slice(0, 140);
      L.push(`| ${ICON[s.status]} | ${s.step} | \`${s.route ?? '—'}\` | ${detail} |`);
    }
    L.push('');
  }
  return L.join('\n');
}
