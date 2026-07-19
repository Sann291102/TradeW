'use client';

import { useRef } from 'react';
import { cn } from '@tradew/ui';

interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  /** Called with the pointer delta (px) since the last event, drag or keyboard. */
  onDelta: (deltaPx: number) => void;
  'aria-label': string;
}

const KEY_STEP = 16;

/**
 * Splitter — a draggable divider between two dock regions (Milestone 3,
 * "Resizable Panels"). Reports raw pixel deltas; the caller (WorkspaceDock)
 * owns clamping/persistence via the workspace store. Pointer Events (not
 * mouse events) so it works the same for mouse, pen, and touch.
 *
 * Keyboard-resizable: focus + Arrow keys nudge by KEY_STEP, satisfying "usable
 * without a mouse" (Milestone 3 accessibility requirement) — dragging isn't
 * the only way to resize.
 */
export function Splitter({ orientation, onDelta, 'aria-label': ariaLabel }: SplitterProps) {
  const lastPos = useRef(0);
  const dragging = useRef(false);

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = true;
    lastPos.current = orientation === 'vertical' ? e.clientX : e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const pos = orientation === 'vertical' ? e.clientX : e.clientY;
    onDelta(pos - lastPos.current);
    lastPos.current = pos;
  }
  function onPointerUp(e: React.PointerEvent) {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const isVert = orientation === 'vertical';
    if (isVert && e.key === 'ArrowLeft') onDelta(-KEY_STEP);
    else if (isVert && e.key === 'ArrowRight') onDelta(KEY_STEP);
    else if (!isVert && e.key === 'ArrowUp') onDelta(-KEY_STEP);
    else if (!isVert && e.key === 'ArrowDown') onDelta(KEY_STEP);
    else return;
    e.preventDefault();
  }

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative shrink-0 touch-none select-none',
        'focus-visible:outline-none',
        orientation === 'vertical' ? 'w-3 cursor-col-resize' : 'h-3 cursor-row-resize',
      )}
    >
      <div
        aria-hidden
        className={cn(
          'absolute rounded-full bg-border2 transition-colors duration-micro',
          'group-hover:bg-teal group-focus-visible:bg-teal group-active:bg-teal',
          orientation === 'vertical'
            ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2',
        )}
      />
    </div>
  );
}
