'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn, Badge } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { SparkleIcon } from './icons';

const QUICK_CHIPS = ['Explain this chart', 'Market pulse', 'Explain my portfolio', 'Open Option Chain'];

/**
 * TradeW AI floating assistant (shell chrome) — the permanent bottom-right dock
 * from the canonical terminal (#aiFab + #aiDock) and TRADEW-ASSISTANT.md.
 * Milestone 2 delivers the VISUAL surface only: FAB, animated dock, message
 * scaffold, quick-action chips, and the required observation-only disclaimer.
 * No AI/routing logic yet (that's a later milestone) — this is the slot.
 *
 * Open state lives in the workspace store (Milestone 3) so Escape/the command
 * palette can close it centrally alongside every other overlay.
 */
export function FloatingAI() {
  const open = useWorkspaceStore((s) => s.aiDockOpen);
  const setOpen = useWorkspaceStore((s) => s.setAiDockOpen);
  const reduce = useReducedMotion();
  return (
    <>
      {/* FAB */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask TradeW AI"
        aria-expanded={open}
        className={cn(
          'fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full',
          'bg-teal text-white shadow-card transition-transform duration-micro',
          'hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          open && 'pointer-events-none opacity-0',
        )}
      >
        <SparkleIcon className="h-5 w-5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.aside
            key="ai-dock"
            role="dialog"
            aria-label="TradeW AI assistant"
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24, y: 8 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24, y: 8 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="fixed bottom-5 right-5 z-50 flex h-[560px] max-h-[calc(100vh-2.5rem)] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-card border border-border bg-card shadow-card"
          >
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal text-white">
                <SparkleIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-bold text-text">TradeW AI</div>
                <div className="flex items-center gap-1 text-[11px] text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-up" /> Online
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Close
              </button>
            </header>

            <div className="flex-1 space-y-3 overflow-auto p-4">
              <div className="max-w-[85%] rounded-card rounded-tl-sm border border-border bg-bg px-3 py-2 text-sm text-text">
                Hi — I&apos;m TradeW AI, your workspace assistant. Ask me to open a chart, explain
                your portfolio, or navigate anywhere in the app.
              </div>
              <div className="flex items-center gap-2 text-[11px] text-faint">
                <Badge tone="brand" className="px-1.5 py-0 text-[9px]">
                  BETA
                </Badge>
                Interface preview — responses arrive in a later milestone.
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 px-4 pb-2">
              {QUICK_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="rounded-full border border-border2 px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors duration-micro hover:border-teal hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {c}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 border-t border-border p-3">
              <input
                aria-label="Message TradeW AI"
                placeholder="Ask TradeW AI…"
                className="flex-1 rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              <button
                type="button"
                className="rounded-lg bg-teal px-3 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Send
              </button>
            </div>
            <p className="border-t border-border px-4 py-2 text-[10px] leading-tight text-faint">
              TradeW AI shares observations only — never investment advice.
            </p>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
