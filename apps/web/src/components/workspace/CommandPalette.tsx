'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { runSearch } from '@/lib/search/providers';
import type { SearchContext, SearchResult } from '@/lib/search/types';
import { SearchIcon } from '../shell/icons';

/**
 * CommandPalette — Ctrl/⌘+K (Milestone 3 §5), and doubles as Global Search
 * (§6): one overlay, modular providers grouped by domain (navigation, stocks,
 * learning, commands, plus stub providers for Portfolio/Research/Sentinel/
 * Knowledge/TradeW AI — real backend search replaces a provider's `search()`
 * body without touching this component).
 */
export function CommandPalette() {
  const open = useWorkspaceStore((s) => s.commandPaletteOpen);
  const setOpen = useWorkspaceStore((s) => s.setCommandPaletteOpen);
  const router = useRouter();
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const setSelectedSymbol = useWorkspaceStore((s) => s.setSelectedSymbol);
  const setTheme = useWorkspaceStore((s) => s.setTheme);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  const setNotificationCenterOpen = useWorkspaceStore((s) => s.setNotificationCenterOpen);
  const setShortcutsHelpOpen = useWorkspaceStore((s) => s.setShortcutsHelpOpen);
  const applyLayout = useWorkspaceStore((s) => s.applyLayout);
  const activeTab = useWorkspaceStore((s) => s.activeTab());
  const addWorkspaceTab = useWorkspaceStore((s) => s.addWorkspaceTab);

  const ctx: SearchContext = useMemo(
    () => ({
      navigate: (href) => {
        router.push(href);
        setOpen(false);
      },
      setSelectedSymbol,
      setTheme,
      toggleSidebar,
      openNotifications: () => setNotificationCenterOpen(true),
      openShortcutsHelp: () => setShortcutsHelpOpen(true),
      resetLayout: () => applyLayout(activeTab.activeLayoutId),
      newWorkspaceTab: () => addWorkspaceTab(),
    }),
    [router, setOpen, setSelectedSymbol, setTheme, toggleSidebar, setNotificationCenterOpen, setShortcutsHelpOpen, applyLayout, activeTab.activeLayoutId, addWorkspaceTab],
  );

  const groups = useMemo(() => runSearch(query, ctx), [query, ctx]);
  const flat = useMemo(() => groups.flatMap((g) => g.results.filter((r) => !r.disabled)), [groups]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // focus after the enter animation frame so autofocus doesn't fight the transition
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function activate(result: SearchResult) {
    if (result.disabled) return;
    result.action?.();
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const result = flat[activeIndex];
      if (result) activate(result);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-border bg-card shadow-card"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <SearchIcon className="h-4 w-4 shrink-0 text-faint" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search stocks, pages, learning topics, commands…"
                aria-label="Command palette search"
                autoComplete="off"
                className="w-full bg-transparent text-sm text-text placeholder:text-faint focus-visible:outline-none"
              />
              <kbd className="shrink-0 rounded border border-border2 px-1.5 py-0.5 text-[10px] font-semibold text-faint">esc</kbd>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {groups.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-faint">
                  {query ? 'No results — try a stock symbol, page, or command.' : 'Type to search everywhere.'}
                </p>
              ) : (
                groups.map((group) => (
                  <div key={group.provider.id} className="mb-1">
                    <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-faint">
                      {group.provider.label}
                    </div>
                    {group.results.map((result) => {
                      const flatIndex = flat.indexOf(result);
                      const active = flatIndex >= 0 && flatIndex === activeIndex;
                      const Icon = result.icon;
                      return (
                        <button
                          key={result.id}
                          type="button"
                          disabled={result.disabled}
                          onMouseEnter={() => flatIndex >= 0 && setActiveIndex(flatIndex)}
                          onClick={() => activate(result)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm',
                            'transition-colors duration-micro',
                            result.disabled
                              ? 'cursor-not-allowed text-faint'
                              : active
                                ? 'bg-teal-bg text-teal'
                                : 'text-text hover:bg-hover',
                          )}
                        >
                          {Icon && <Icon className="h-4 w-4 shrink-0" />}
                          <span className="min-w-0 flex-1 truncate">{result.title}</span>
                          {result.subtitle && (
                            <span className="shrink-0 truncate text-[11px] text-faint">{result.subtitle}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[10px] text-faint">
              <span>↑↓ navigate</span>
              <span>↵ select</span>
              <span>esc close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
