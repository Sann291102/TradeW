'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { SHORTCUTS } from '@/lib/shortcuts';

/** ShortcutsHelp — Ctrl/⌘+/ reference overlay (Milestone 3 §7, "document all shortcuts"). */
export function ShortcutsHelp() {
  const open = useWorkspaceStore((s) => s.shortcutsHelpOpen);
  const setOpen = useWorkspaceStore((s) => s.setShortcutsHelpOpen);
  const reduce = useReducedMotion();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
          onClick={() => setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[75vh] w-full max-w-md overflow-y-auto rounded-card border border-border bg-card p-5 shadow-card"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-text">Keyboard shortcuts</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Esc
              </button>
            </div>
            <ul className="space-y-1.5">
              {SHORTCUTS.map((s) => (
                <li key={s.combo} className="flex items-center justify-between gap-4 text-xs">
                  <span className="text-muted">{s.description}</span>
                  <kbd className="shrink-0 rounded border border-border2 bg-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text">
                    {s.combo}
                  </kbd>
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
