import { SessionBudgetCard } from '@/components/discipline/SessionBudgetCard';

export const metadata = { title: "Today's limits — TradeW" };

/**
 * Discipline session — the read-only view of the limits the trader set for
 * today and what is left of each.
 *
 * Server component wrapping the client card, matching `/notifications`. The
 * card owns its own data fetch and starts the discipline store itself, so this
 * route works whether or not the app shell has already started it.
 *
 * Read-only by design: limits are set once in the panel at the start of the
 * session. There is no edit control here, and adding one would defeat the
 * point — a limit you can quietly raise at the moment it binds is not a limit.
 * Going past one costs a written reason on the order path instead.
 */
export default function DisciplinePage() {
  return (
    <div className="mx-auto max-w-[560px] space-y-4 p-4">
      <SessionBudgetCard />
      <p className="px-1 text-[11px] leading-relaxed text-faint">
        These are limits you set for yourself at the start of the session. TradeW records them and shows them back to
        you — it never sets them for you, and never suggests what to trade.
      </p>
    </div>
  );
}
