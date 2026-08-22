'use client';

import { Card, buttonClasses, cn } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import { useWorkspaceStore, type ThemeName } from '@/lib/store/workspaceStore';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_CANDLE_UP,
  DEFAULT_CANDLE_DOWN,
  HEX_COLOR,
  type ThemePreference,
} from '@/lib/settings/preferences';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { CandlePreview } from '@/components/settings/CandlePreview';
import { SaveStatus, SettingRow, SignInRequired, Toggle } from '@/components/settings/controls';
import { SunIcon, MoonIcon, ContrastIcon, DeviceIcon, CheckIcon } from '@/components/shell/icons';

/**
 * Settings → Appearance.
 *
 * ── THE CHAIN THIS PAGE COMPLETES ──────────────────────────────────────────
 *
 *   picker here
 *     → `appearance` preference document (POST /auth/preferences/appearance)
 *     → SettingsEffects writes `--candle-up` / `--candle-down` on <html>
 *     → TradeChart reads those custom properties in `applyTheme()`
 *     → every candlestick and area series in the app repaints
 *
 * That last step is the point. A colour picker that only recolours a swatch on
 * the settings page is the failure mode this was written to avoid, so the
 * colours are pushed into the DOM the chart already reads from rather than
 * into a second theme system.
 *
 * ONE chart implementation consumes them: `components/charts/TradeChart.tsx`
 * (lightweight-charts), used by the Trade dock, the market workspaces, the
 * Sentinel chart panels and the dashboard overview. `Sparkline` in `@tradew/ui`
 * is not a candle chart and deliberately keeps following the theme's own
 * direction colours.
 */

const THEMES: Array<{ id: ThemePreference; label: string; hint: string; icon: typeof SunIcon }> = [
  { id: 'light', label: 'Light', hint: 'Always light', icon: SunIcon },
  { id: 'dark', label: 'Dark', hint: 'Always dark', icon: MoonIcon },
  { id: 'system', label: 'System', hint: 'Follows your device', icon: DeviceIcon },
  { id: 'high-contrast', label: 'High contrast', hint: 'Maximum legibility', icon: ContrastIcon },
];

export function AppearanceSection() {
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const prefs = useSettingsStore((s) => s.prefs.appearance);
  const update = useSettingsStore((s) => s.update);
  const replace = useSettingsStore((s) => s.replace);
  const saving = useSettingsStore((s) => s.saveState.appearance === 'saving');
  const setLocalTheme = useWorkspaceStore((s) => s.setTheme);
  const localTheme = useWorkspaceStore((s) => s.theme);

  /**
   * Theme is the one setting that has to apply for a signed-out visitor too —
   * it is also reachable from the top bar, and a theme that only worked once
   * you signed in would be a strange thing to explain. So the local store is
   * always updated (that is what the renderer reads and what survives a
   * reload), and the account copy is written on top of it when there is an
   * account to write to.
   */
  function chooseTheme(theme: ThemePreference) {
    setLocalTheme(theme as ThemeName);
    if (signedIn) void update('appearance', { theme });
  }

  // Colour inputs are only meaningful against a stored document, so they are
  // gated on a session in a way the theme picker is not.
  const effectiveTheme = signedIn ? prefs.theme : (localTheme as ThemePreference);
  const isDefaultColors = prefs.candleUp === DEFAULT_CANDLE_UP && prefs.candleDown === DEFAULT_CANDLE_DOWN;

  return (
    <SettingsSection
      title="Appearance"
      description="How TradeW looks, and how your charts are painted."
    >
      <Card title="Theme" subtitle="· applies immediately" actions={signedIn ? <SaveStatus section="appearance" /> : undefined}>
        <div className="grid gap-2 sm:grid-cols-4">
          {THEMES.map((t) => {
            const active = effectiveTheme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={active}
                onClick={() => chooseTheme(t.id)}
                className={cn(
                  'relative flex flex-col items-center gap-1.5 rounded-lg border px-3 py-4 transition-colors duration-micro',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  active ? 'border-teal bg-teal-bg text-teal' : 'border-border text-muted hover:bg-hover hover:text-text',
                )}
              >
                {active && (
                  <CheckIcon className="absolute right-2 top-2 h-3.5 w-3.5" aria-hidden="true" />
                )}
                <t.icon className="h-6 w-6" aria-hidden="true" />
                <span className="text-xs font-bold">{t.label}</span>
                <span className="text-[10px] text-faint">{t.hint}</span>
              </button>
            );
          })}
        </div>
        {!signedIn && (
          <p className="mt-3 text-[11px] text-faint">
            Your theme is remembered on this device. Sign in to have it follow your account.
          </p>
        )}
      </Card>

      {signedIn ? (
        <>
          <Card
            title="Candle colours"
            subtitle="· applied to every chart"
            actions={
              <button
                type="button"
                disabled={saving || isDefaultColors}
                onClick={() =>
                  void update('appearance', {
                    candleUp: DEFAULT_CANDLE_UP,
                    candleDown: DEFAULT_CANDLE_DOWN,
                  })
                }
                className={buttonClasses({ variant: 'outline', size: 'sm' })}
              >
                Reset to default
              </button>
            }
          >
            <p className="mb-3 max-w-prose text-xs leading-relaxed text-muted">
              These colours are written to the document as CSS custom properties and read by the
              chart engine, so a change here repaints the charts on Trade, Markets, Sentinel and
              Home — not just the preview below.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                id="candle-up"
                label="Bullish (up)"
                value={prefs.candleUp}
                disabled={saving}
                onCommit={(candleUp) => void update('appearance', { candleUp })}
              />
              <ColorField
                id="candle-down"
                label="Bearish (down)"
                value={prefs.candleDown}
                disabled={saving}
                onCommit={(candleDown) => void update('appearance', { candleDown })}
              />
            </div>

            <div className="mt-4 rounded-lg border border-border bg-bg p-3">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-faint">Preview</div>
              <CandlePreview up={prefs.candleUp} down={prefs.candleDown} hollowUp={prefs.hollowUpCandles} />
            </div>
          </Card>

          <Card title="Chart preferences" actions={<SaveStatus section="appearance" />}>
            <SettingRow
              label="Hollow up-candles"
              htmlFor="hollow-up"
              hint="Draw rising candles as an outline rather than a filled body — the convention on many desktop terminals."
              control={
                <Toggle
                  id="hollow-up"
                  label="Hollow up-candles"
                  disabled={saving}
                  checked={prefs.hollowUpCandles}
                  onChange={(hollowUpCandles) => void update('appearance', { hollowUpCandles })}
                />
              }
            />
            <SettingRow
              label="Grid lines"
              htmlFor="chart-grid"
              hint="Horizontal and vertical grid on the chart background."
              control={
                <Toggle
                  id="chart-grid"
                  label="Grid lines"
                  disabled={saving}
                  checked={prefs.showChartGrid}
                  onChange={(showChartGrid) => void update('appearance', { showChartGrid })}
                />
              }
            />
            <SettingRow
              label="Crosshair"
              htmlFor="chart-crosshair"
              hint="The tracking crosshair and its axis labels."
              control={
                <Toggle
                  id="chart-crosshair"
                  label="Crosshair"
                  disabled={saving}
                  checked={prefs.showCrosshair}
                  onChange={(showCrosshair) => void update('appearance', { showCrosshair })}
                />
              }
            />
            <SettingRow
              label="Volume, indicator defaults, price-scale mode"
              hint="Not exposed as preferences."
              unavailable="The chart component takes no volume pane, no default indicator set and no price-scale mode, so there is nothing for a setting to change. Each would be a change to the charting layer first."
              control={<span className="text-sm text-muted">—</span>}
            />
            <SettingRow
              label="Chart timezone"
              hint="Chart axes render in IST."
              unavailable="Axis ticks and the crosshair formatter are IST-relative by construction (NSE session hours). Making it configurable would move the trading day on the axis."
              control={<span className="text-sm text-muted">IST</span>}
            />
          </Card>
        </>
      ) : (
        <SignInRequired what="save chart colours and chart preferences" />
      )}
    </SettingsSection>
  );
}

/**
 * A colour input paired with a hex field.
 *
 * Commits on `change` (mouse-up / field blur), not on `input`: dragging a
 * native colour picker fires continuously, and each event here is a network
 * write. The hex box commits only once it holds a valid colour, so a
 * half-typed `#2` never reaches the chart.
 */
function ColorField({
  id,
  label,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onCommit: (next: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-semibold text-faint">
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-border2 bg-bg p-2">
        <input
          id={id}
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value)}
          aria-label={`${label} colour`}
          className="h-8 w-10 shrink-0 cursor-pointer rounded border border-border2 bg-transparent disabled:cursor-not-allowed"
        />
        <input
          type="text"
          defaultValue={value}
          key={value}
          disabled={disabled}
          aria-label={`${label} hex value`}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (HEX_COLOR.test(next) && next.toLowerCase() !== value.toLowerCase()) onCommit(next);
            else e.target.value = value;
          }}
          className={cn(
            'w-full bg-transparent font-mono text-sm uppercase text-text',
            'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
      </div>
      <p className="mt-1 text-[10px] text-faint">
        Default {label.startsWith('Bullish') ? DEFAULT_APPEARANCE.candleUp : DEFAULT_APPEARANCE.candleDown}
      </p>
    </div>
  );
}
