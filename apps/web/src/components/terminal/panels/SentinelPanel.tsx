'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Panel, Badge, buttonClasses } from '@tradew/ui';
import { OBSERVATION_ONLY_DISCLAIMER } from '@/lib/sentinel/types';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSentinel } from '@/lib/sentinel/useSentinel';
import { extractSafetyFeed, pushworthyCards } from '@/lib/sentinel/deriveContext';
import { SafetyCard } from '@/components/sentinel/SafetyCard';
import { SentinelIcon } from '../../shell/icons';
import type { DockPanelContentProps } from './types';

/**
 * Sentinel slot in the terminal — always visible, but premium reasoning is
 * entitlement-gated (SUBSCRIPTIONS.md §4, TRADEW-OS.md §5). Shows live safety
 * feed when entitled, or coupon upgrade form when locked.
 */
export function SentinelPanel({ className, actions, collapsed }: DockPanelContentProps) {
  const [mounted, setMounted] = useState(false);
  const hasSentinel = useSessionStore((s) => s.hasCapability('sentinel'));
  const redeemCoupon = useSessionStore((s) => s.redeemCoupon);
  const [couponCode, setCouponCode] = useState('HashtagTradeWSetup100');
  const [couponMsg, setCouponMsg] = useState<{ success?: boolean; text: string } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isEntitled = mounted && hasSentinel;

  const { data, loading } = useSentinel('NIFTY');
  const observations = data?.observations ?? [];
  const safetyCards = extractSafetyFeed(observations, data?.synthesis ?? null, data?.sideInFocus ?? null);
  const feedCards = pushworthyCards(safetyCards);

  const handleApplyCoupon = (e: React.FormEvent) => {
    e.preventDefault();
    const res = redeemCoupon(couponCode);
    setCouponMsg({ success: res.success, text: res.message });
  };

  return (
    <Panel
      className={className}
      collapsed={collapsed}
      title={
        <span className="flex items-center gap-1.5 normal-case">
          <SentinelIcon className="h-4 w-4 text-teal" />
          Sentinel
        </span>
      }
      actions={
        <>
          {isEntitled ? (
            <Badge tone="positive" className="px-1.5 py-0 text-[9px]">ACTIVE PRO</Badge>
          ) : (
            <Badge tone="warning" className="px-1.5 py-0 text-[9px]">PRO</Badge>
          )}
          {actions}
        </>
      }
    >
      {isEntitled ? (
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wide text-faint">
              Live Safety Feed ({feedCards.length})
            </span>
            <Link href="/sentinel" className="text-[11px] text-teal hover:underline font-medium">
              Open Workspace →
            </Link>
          </div>

          {loading ? (
            <div className="py-6 text-center text-xs text-muted">Loading live observations...</div>
          ) : feedCards.length > 0 ? (
            <ul className="max-h-[280px] space-y-2.5 overflow-y-auto pr-1">
              {feedCards.map((card) => (
                <SafetyCard key={card.id} card={card} />
              ))}
            </ul>
          ) : (
            <div className="py-6 text-center text-xs text-muted">
              No safety alerts right now. Sentinel is actively observing live tape in the background.
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 p-4 text-center">
          <p className="text-xs text-muted">
            {OBSERVATION_ONLY_DISCLAIMER} Unlock premium reasoning to see live observations here.
          </p>

          <form onSubmit={handleApplyCoupon} className="w-full space-y-2 max-w-xs mt-1">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value)}
                placeholder="Enter coupon code"
                className="w-full rounded-lg border border-border2 bg-bg px-2.5 py-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus font-mono"
              />
              <button type="submit" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
                Redeem
              </button>
            </div>
            {couponMsg && (
              <p className={`text-[11px] font-medium ${couponMsg.success ? 'text-up' : 'text-down'}`}>
                {couponMsg.text}
              </p>
            )}
          </form>

          <p className="text-[10px] bg-hover px-2 py-1 rounded text-faint border border-border">
            Use code <span className="font-mono text-teal font-semibold">HashtagTradeWSetup100</span> for 1 Month 100% Free PRO
          </p>

          <p className="text-[10px] text-faint">Observation only — never investment advice.</p>
        </div>
      )}
    </Panel>
  );
}
