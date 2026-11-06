import { Badge } from '@tradew/ui';
import { AGENT_EXIT_REASON_LABELS, type OrderAttribution } from '@/lib/oms';

/**
 * Marks an order or trade as the agent's or the trader's own.
 *
 * AGENT rows get a badge plus a second line saying which half of the agent's
 * trade this is — "Entry", or "Exit · Square-off" — so a position the agent
 * opened and then closed reads as an agent trade end to end. MANUAL rows are
 * deliberately quiet: the common case should not carry a badge of its own.
 */
export function OrderSourceBadge({ order, compact = false }: { order: OrderAttribution; compact?: boolean }) {
  if (order.source !== 'AGENT') {
    return compact ? null : <span className="text-[11px] text-faint">Manual</span>;
  }
  const reason = order.exitReason ? (AGENT_EXIT_REASON_LABELS[order.exitReason] ?? order.exitReason) : null;
  const role = order.role === 'EXIT' ? (reason ? `Exit · ${reason}` : 'Exit') : order.role === 'ENTRY' ? 'Entry' : null;
  const title = [order.agent, role].filter(Boolean).join(' — ') || 'Placed by a Sentinel agent';
  return (
    <span className="inline-flex flex-col items-start gap-0.5" title={title}>
      <Badge tone="brand" className="px-1.5 py-0 text-[9px]">
        Agent
      </Badge>
      {role && <span className="text-[10px] leading-tight text-muted">{role}</span>}
    </span>
  );
}
