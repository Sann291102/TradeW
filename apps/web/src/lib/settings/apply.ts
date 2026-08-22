'use client';

import { HEX_COLOR } from './preferences';

/**
 * localStorage key holding a paint-time mirror of the account's candle
 * colours.
 *
 * The authority is the `appearance` preference row on the server. This copy
 * exists so the inline script in `app/layout.tsx` can colour the first frame:
 * charts mount immediately, `GET /auth/preferences` does not, and repainting
 * every candle a second after load is a worse experience than the colours
 * arriving with the page. It is cleared on sign-out.
 */
export const CANDLE_COLOR_CACHE_KEY = 'tradew-candle-colors-v1';

/**
 * Put the user's candle colours where the charts can see them.
 *
 * Two mechanisms, both required:
 *
 *  · the CSS custom properties `--candle-up` / `--candle-down`, which is what
 *    `TradeChart` actually reads (they default, in tokens.css, to the theme's
 *    `--green` / `--red`, so an account that has never touched this setting
 *    still re-themes correctly with light/dark);
 *  · matching `data-candle-up` / `data-candle-down` ATTRIBUTES, which exist
 *    purely so the chart's MutationObserver fires. It watches attributes, and
 *    a `style` property write on the same element is not one it can filter
 *    for without also waking on every unrelated inline-style change.
 *
 * Invalid values are ignored rather than written through: a bad custom
 * property would make lightweight-charts fall back to its own default palette,
 * which looks like a bug in the chart rather than a bad setting.
 */
export function applyCandleColors(up: string, down: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (HEX_COLOR.test(up)) {
    root.style.setProperty('--candle-up', up);
    root.setAttribute('data-candle-up', up);
  }
  if (HEX_COLOR.test(down)) {
    root.style.setProperty('--candle-down', down);
    root.setAttribute('data-candle-down', down);
  }
  try {
    localStorage.setItem(CANDLE_COLOR_CACHE_KEY, JSON.stringify({ up, down }));
  } catch {
    /* storage unavailable — the colours still apply for this page load */
  }
}
