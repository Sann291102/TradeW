'use client';

import { useEffect, useRef } from 'react';
import { buttonClasses } from '@tradew/ui';

/**
 * A small accessible confirmation dialog on the native <dialog> element:
 * focus is trapped by the browser, Escape cancels, and the confirm button is
 * styled by `tone` (danger for destructive actions).
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'danger',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="w-[min(92vw,420px)] rounded-2xl border border-border2 bg-card p-0 text-text shadow-elev2 backdrop:bg-black/50"
    >
      <div className="p-5">
        <h3 id="confirm-title" className="text-base font-bold">
          {title}
        </h3>
        <div className="mt-2 text-sm text-muted">{body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={buttonClasses({ variant: tone === 'danger' ? 'danger' : 'primary', size: 'sm' })}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
