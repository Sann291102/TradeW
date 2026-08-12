'use client';

import { useState } from 'react';
import {
  admin,
  type PerceptDomain,
  type PerceptorRow,
  type ProposalRow,
} from '@/lib/admin/api';
import { NeuralLayers, WeightBar, perceptorTone } from '../components/NeuralLayers';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  Table,
  Td,
  Th,
  ago,
  fmtMs,
  fmtNum,
  fmtTime,
  usePolling,
} from '../components/ui';

/**
 * Perceptors & Neural Networks — what the platform senses, and what it has learned.
 *
 * Ordered by the question each block answers, hardest first:
 *
 *  1. **Is it running at all** — the banner. A disabled network and a broken one
 *     look identical from every other block on this page, so the distinction is
 *     made once, at the top, in words.
 *  2. **Where does the signal stop** — the four-layer diagram. The only view
 *     that makes a dead middle layer visible.
 *  3. **Which sensors are alive** — the perceptor roster, including the ones
 *     that are registered and silent, which is the fault no event view can show.
 *  4. **What it has learned** — the weights, with an unproven/proven split,
 *     because a weight nothing has scored is a guess and must not read as a
 *     finding.
 *  5. **What it wants a human to do** — the proposal queue. Resolving one is
 *     also how the network is told it was wrong, and dismissal is the only
 *     negative training signal it ever receives.
 *  6. **What it has been doing** — recent passes, including the ones that
 *     produced nothing.
 */
export default function AdminCognitionPage() {
  const [domain, setDomain] = useState<PerceptDomain | ''>('');
  const [proposalStatus, setProposalStatus] = useState('pending');
  const [busy, setBusy] = useState<string | null>(null);

  const overview = usePolling(() => admin.cognition.overview(), [], 10_000);
  const perceptors = usePolling(() => admin.cognition.perceptors(), [], 15_000);
  const episodes = usePolling(
    () => admin.cognition.episodes({ limit: 40, domain: domain || undefined, hours: 24 }),
    [domain],
    15_000,
  );
  const synapses = usePolling(() => admin.cognition.synapses({ limit: 60 }), [], 30_000);
  const proposals = usePolling(
    () => admin.cognition.proposals({ status: proposalStatus || undefined, limit: 50 }),
    [proposalStatus],
    15_000,
  );

  const snap = overview.data;
  const sensors = perceptors.data ?? [];
  const running = Boolean(snap?.enabled && snap.isLeader);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      // Refresh everything a write can move. The proposal queue and the weight
      // table are coupled — resolving a proposal is what reinforces synapses —
      // so refreshing one without the other shows a half-applied world.
      overview.refresh();
      proposals.refresh();
      synapses.refresh();
      perceptors.refresh();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Perceptors &amp; Neural Networks</h1>
          <p className="text-[12px] text-muted">
            What the platform senses across market, application, assistant, learning and platform — and what repeated
            outcomes have taught it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value as PerceptDomain | '')}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
          >
            <option value="">All domains</option>
            <option value="market">Market</option>
            <option value="application">Application</option>
            <option value="assistant">Assistant (Tara)</option>
            <option value="learning">Learning</option>
            <option value="platform">Platform</option>
          </select>
          <button
            type="button"
            disabled={!snap?.enabled || busy !== null}
            onClick={() => void act('run', () => admin.cognition.run(domain || undefined))}
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-white/20 hover:text-text disabled:opacity-40"
          >
            {busy === 'run' ? 'Running…' : 'Run a pass now'}
          </button>
        </div>
      </header>

      {/* 1 — is it running. Stated in words, because every other block on this
          page looks the same whether the network is off or broken. */}
      {snap && !running && (
        <div className="rounded-xl border border-amber/30 bg-amber/[0.06] px-4 py-2.5 text-[12px] text-amber">
          {!snap.enabled ? (
            <>
              The network is <strong>registered but not running</strong> — {sensors.length} perceptors are declared and
              no passes are being made. Set <code className="text-[11px]">COGNITION_ENABLED=true</code> to start it.
            </>
          ) : (
            <>
              This instance holds the roster but is <strong>not the leader</strong> for the cognition job, so another
              replica is running the passes. The weights and episodes below are shared; the live layer counters are not.
            </>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Perceptors"
          value={fmtNum(sensors.length)}
          sub={`${sensors.filter((s) => s.enabled).length} enabled · ${sensors.filter((s) => s.health?.status === 'stale' || s.health?.status === 'quarantined').length} not producing`}
          tone={sensors.some((s) => s.health?.status === 'quarantined') ? 'bad' : 'neutral'}
        />
        <Stat
          label="Learned associations"
          value={fmtNum(snap?.synapses.total ?? 0)}
          // The split is the point: an unproven weight is a guess the network
          // made that no outcome has ever confirmed or refuted.
          sub={`${fmtNum(snap?.synapses.proven ?? 0)} scored by an outcome · ${fmtNum(snap?.synapses.unproven ?? 0)} unproven`}
          tone={snap && snap.synapses.proven === 0 && snap.synapses.total > 0 ? 'warn' : 'neutral'}
        />
        <Stat
          label="Outcomes applied"
          value={fmtNum(snap?.synapses.totalReinforcements ?? 0)}
          sub={`${fmtNum(snap?.synapses.totalActivations ?? 0)} firings recorded`}
        />
        <Stat
          label="Awaiting an outcome"
          value={fmtNum(snap?.synapses.pendingTraces ?? 0)}
          // A trace count that only grows means nothing is ever being scored,
          // which stops learning silently — no error, no failed request.
          sub="firings with no result yet — a number that only grows means learning has stalled"
          tone={(snap?.synapses.pendingTraces ?? 0) > 5_000 ? 'warn' : 'neutral'}
        />
      </div>

      {/* 2 — where does the signal stop */}
      {snap && <NeuralLayers layers={snap.layers} perceptors={sensors} running={running} />}

      {/* 3 — which sensors are alive */}
      <Panel
        title="Perceptors"
        subtitle="Every registered sensor, including the disabled and the silent. A sensor that has stopped producing is the fault no event-driven view can show."
      >
        {sensors.length === 0 ? (
          <Empty>{perceptors.loading ? 'Loading…' : 'No perceptors registered.'}</Empty>
        ) : (
          <Table
            head={
              <>
                <Th>Sensor</Th>
                <Th>Domain</Th>
                <Th>Status</Th>
                <Th>Cadence</Th>
                <Th className="text-right">Last percept</Th>
                <Th className="text-right">Mean salience</Th>
                <Th className="text-right">Total</Th>
                <Th />
              </>
            }
          >
            {sensors.map((sensor) => (
              <PerceptorRowView
                key={sensor.id}
                sensor={sensor}
                busy={busy === sensor.id}
                onToggle={() =>
                  void act(sensor.id, () => admin.cognition.setPerceptorEnabled(sensor.id, !sensor.enabled))
                }
              />
            ))}
          </Table>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* 4 — what it has learned */}
        <Panel
          title="Learned weights"
          subtitle="Strongest associations first. Unproven means no outcome has ever scored it — a guess, not a finding."
        >
          {(synapses.data ?? []).length === 0 ? (
            <Empty>
              {synapses.loading
                ? 'Loading…'
                : 'Nothing learned yet. Weights appear once the network has run a pass that associated something.'}
            </Empty>
          ) : (
            <Table
              head={
                <>
                  <Th>Association</Th>
                  <Th>Layer</Th>
                  <Th className="text-right">Weight</Th>
                  <Th className="text-right">Fired / scored</Th>
                </>
              }
            >
              {(synapses.data ?? []).map((synapse) => (
                <tr key={synapse.id} className="hover:bg-white/[0.02]">
                  <Td className="max-w-[260px]">
                    <div className="truncate text-[11.5px]" title={`${synapse.source} → ${synapse.target}`}>
                      <span className="text-muted">{shorten(synapse.source)}</span>
                      <span className="px-1 text-faint">→</span>
                      <span>{shorten(synapse.target)}</span>
                    </div>
                    <div className="text-[10px] text-faint">
                      {synapse.lastActivatedAt ? `fired ${ago(synapse.lastActivatedAt)}` : 'never fired'}
                    </div>
                  </Td>
                  <Td className="text-[10.5px] text-faint">{synapse.layer.replace(/^L\d_/, '')}</Td>
                  <Td className="text-right">
                    <WeightBar weight={synapse.weight} reinforcements={synapse.reinforcements} />
                  </Td>
                  <Td className="num text-right text-[11px] text-muted">
                    {fmtNum(synapse.activations)} / {fmtNum(synapse.reinforcements)}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        {/* 5 — what it wants a human to do */}
        <Panel
          title="Proposals"
          subtitle="The network never acts. It proposes, and an operator decides — dismissing one is how it learns it was wrong."
          right={
            <select
              value={proposalStatus}
              onChange={(e) => setProposalStatus(e.target.value)}
              className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 text-[11px] outline-none focus:border-teal"
            >
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="dismissed">Dismissed</option>
              <option value="done">Done</option>
              <option value="">All</option>
            </select>
          }
        >
          {(proposals.data ?? []).length === 0 ? (
            <Empty>{proposals.loading ? 'Loading…' : 'Nothing proposed. A quiet queue is the normal state.'}</Empty>
          ) : (
            <div className="max-h-[520px] divide-y divide-white/[0.04] overflow-auto">
              {(proposals.data ?? []).map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  busy={busy === proposal.id}
                  onResolve={(status) =>
                    void act(proposal.id, () => admin.cognition.resolveProposal(proposal.id, status))
                  }
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* 6 — what it has been doing */}
      <Panel
        title="Recent passes"
        subtitle="Including the ones that produced nothing — that is what distinguishes a quiet network from a stopped one."
      >
        {(episodes.data ?? []).length === 0 ? (
          <Empty>{episodes.loading ? 'Loading…' : 'No passes in the last 24 hours.'}</Empty>
        ) : (
          <Table
            head={
              <>
                <Th>Started</Th>
                <Th>Trigger</Th>
                <Th>Domain</Th>
                <Th>Status</Th>
                <Th className="text-right">Sensed</Th>
                <Th className="text-right">Gated</Th>
                <Th className="text-right">Hypotheses</Th>
                <Th className="text-right">Promoted</Th>
                <Th className="text-right">Duration</Th>
                <Th>Outcome</Th>
              </>
            }
          >
            {(episodes.data ?? []).map((episode) => {
              const durationMs = episode.finishedAt
                ? new Date(episode.finishedAt).getTime() - new Date(episode.startedAt).getTime()
                : null;
              return (
                <tr key={episode.id} className="hover:bg-white/[0.02]">
                  <Td className="text-[11px] text-muted">{fmtTime(episode.startedAt)}</Td>
                  <Td className="text-[11px]">{episode.trigger}</Td>
                  <Td className="text-[11px] text-muted">{episode.domain ?? 'all'}</Td>
                  <Td>
                    <Pill
                      tone={
                        episode.status === 'ok'
                          ? 'good'
                          : episode.status === 'degraded'
                            ? 'warn'
                            : episode.status === 'error'
                              ? 'bad'
                              : 'neutral'
                      }
                    >
                      {episode.status}
                    </Pill>
                  </Td>
                  <Td className="num text-right">{fmtNum(episode.perceptCount)}</Td>
                  <Td className="num text-right text-faint">
                    <span title="Percepts dropped below the salience floor">{fmtNum(episode.gatedCount)}</span>
                  </Td>
                  <Td className="num text-right">{fmtNum(episode.hypothesisCount)}</Td>
                  <Td className="num text-right">{fmtNum(episode.promotedCount)}</Td>
                  <Td className="num text-right text-muted">{fmtMs(durationMs)}</Td>
                  <Td>
                    {episode.reward === null ? (
                      <span className="text-[10.5px] text-faint">unscored</span>
                    ) : (
                      <Pill tone={episode.reward >= 0.7 ? 'good' : episode.reward <= 0.3 ? 'bad' : 'neutral'}>
                        {episode.reward.toFixed(2)}
                      </Pill>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PerceptorRowView({
  sensor,
  busy,
  onToggle,
}: {
  sensor: PerceptorRow;
  busy: boolean;
  onToggle: () => void;
}) {
  const status = sensor.enabled ? (sensor.health?.status ?? 'healthy') : 'disabled';
  return (
    <tr className="hover:bg-white/[0.02]">
      <Td className="max-w-[280px]">
        <div className="truncate text-[12px]">{sensor.label}</div>
        <div className="truncate text-[10px] text-faint" title={sensor.description}>
          {sensor.description}
        </div>
      </Td>
      <Td className="text-[11px] text-muted">{sensor.domain}</Td>
      <Td>
        <Pill tone={perceptorTone(status)}>{status}</Pill>
        {sensor.health?.lastError && (
          <div className="mt-0.5 max-w-[200px] truncate text-[10px] text-down" title={sensor.health.lastError}>
            {sensor.health.lastError}
          </div>
        )}
      </Td>
      <Td className="text-[11px] text-muted">
        {sensor.cadence === 'interval' && sensor.expectedIntervalMs
          ? `every ${Math.round(sensor.expectedIntervalMs / 1000)}s`
          : sensor.cadence}
      </Td>
      <Td className="text-right text-[11px] text-muted">{ago(sensor.health?.lastPerceptAt ?? null)}</Td>
      <Td className="num text-right text-[11px] text-muted">{(sensor.health?.meanSalience ?? 0).toFixed(2)}</Td>
      <Td className="num text-right text-[11px]">{fmtNum(sensor.health?.totalPercepts ?? 0)}</Td>
      <Td className="text-right">
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          className="rounded border border-white/10 px-1.5 py-px text-[10.5px] text-muted transition-colors hover:border-white/25 hover:text-text disabled:opacity-40"
        >
          {busy ? '…' : sensor.enabled ? 'Disable' : 'Enable'}
        </button>
      </Td>
    </tr>
  );
}

function ProposalCard({
  proposal,
  busy,
  onResolve,
}: {
  proposal: ProposalRow;
  busy: boolean;
  onResolve: (status: 'accepted' | 'dismissed' | 'done') => void;
}) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Pill tone={proposal.kind === 'investigate' ? 'warn' : 'info'}>{proposal.kind}</Pill>
            <span className="text-[10.5px] text-faint">{proposal.domain}</span>
            <span className="num text-[10.5px] text-faint">{(proposal.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="mt-1 text-[12px]">{proposal.title}</div>
          <div className="mt-0.5 text-[10.5px] text-faint">
            {proposal.perceptIds.length} percept{proposal.perceptIds.length === 1 ? '' : 's'} · {ago(proposal.createdAt)}
          </div>
        </div>

        {proposal.status === 'pending' ? (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve('accepted')}
              className="rounded border border-up/40 px-1.5 py-px text-[10.5px] text-up transition-colors hover:bg-up/10 disabled:opacity-40"
            >
              Useful
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve('dismissed')}
              // The only negative training signal the network ever receives.
              title="Tells the network this finding was wrong — the only negative signal it gets"
              className="rounded border border-down/40 px-1.5 py-px text-[10.5px] text-down transition-colors hover:bg-down/10 disabled:opacity-40"
            >
              Wrong
            </button>
          </div>
        ) : (
          <Pill tone={proposal.status === 'dismissed' ? 'bad' : 'good'}>{proposal.status}</Pill>
        )}
      </div>
    </div>
  );
}

/** Trim a synapse endpoint to its readable tail — `percept:application.error-rate/error_rate_spike`
 *  is unreadable in a table cell, and the namespace prefix is the least
 *  informative part of it. The full value stays in the `title`. */
function shorten(endpoint: string): string {
  const [, ...rest] = endpoint.split(':');
  return rest.join(':') || endpoint;
}
