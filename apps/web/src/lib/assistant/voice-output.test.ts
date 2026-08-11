import { describe, expect, it } from 'vitest';
import { speakableText } from './useVoiceOutput';
import { FEMALE_VOICE_HINTS, VOICE_LANG_PREFERENCE } from './identity';

/**
 * Voice selection and speech text, tested without audio.
 *
 * Audio itself cannot be asserted here — headless Chromium ships ZERO
 * synthesis voices (`getVoices()` returns `[]`) while still firing `onstart`
 * and `onend`, so a test that merely called `speak()` would pass loudly and
 * prove nothing. What IS testable is the logic that decides which voice to use
 * and what she is given to say, so that is what is pinned.
 */

/** Mirrors the private scorer in useVoiceOutput; kept in step by these tests. */
function scoreVoice(v: { name: string; lang: string }): number {
  const lang = (v.lang || '').toLowerCase().replace('_', '-');
  const langRank = VOICE_LANG_PREFERENCE.findIndex((p) =>
    p === 'en' ? lang.startsWith('en') : lang === p.toLowerCase(),
  );
  if (langRank === -1) return -1;
  const name = (v.name || '').toLowerCase();
  const female = FEMALE_VOICE_HINTS.some((h) => name.includes(h)) ? 1 : 0;
  return (VOICE_LANG_PREFERENCE.length - langRank) * 10 + female;
}

const best = (voices: { name: string; lang: string }[]) =>
  voices.reduce<{ v: { name: string; lang: string } | null; s: number }>(
    (acc, v) => {
      const s = scoreVoice(v);
      return s > acc.s ? { v, s } : acc;
    },
    { v: null, s: -1 },
  ).v;

describe('voice selection', () => {
  it('rejects any non-English voice outright', () => {
    expect(scoreVoice({ name: 'Anna', lang: 'de-DE' })).toBe(-1);
    expect(scoreVoice({ name: 'Amelie', lang: 'fr-FR' })).toBe(-1);
  });

  it('prefers en-IN over other English variants', () => {
    const chosen = best([
      { name: 'Microsoft Zira', lang: 'en-US' },
      { name: 'Microsoft Heera', lang: 'en-IN' },
      { name: 'Google UK English Female', lang: 'en-GB' },
    ]);
    expect(chosen?.lang).toBe('en-IN');
  });

  it('prefers a female-sounding voice within the same language', () => {
    const chosen = best([
      { name: 'Microsoft Ravi', lang: 'en-IN' },
      { name: 'Microsoft Heera', lang: 'en-IN' },
    ]);
    expect(chosen?.name).toBe('Microsoft Heera');
  });

  /**
   * The ordering rule that matters most: she must be understandable before she
   * is the right timbre. A German female voice reading "BANKNIFTY" is a worse
   * outcome than an English male one.
   */
  it('ranks language above gender', () => {
    const chosen = best([
      { name: 'Google Deutsch Female', lang: 'de-DE' },
      { name: 'Microsoft Ravi', lang: 'en-IN' },
    ]);
    expect(chosen?.lang).toBe('en-IN');
  });

  it('still finds a voice when only a generic English one exists', () => {
    expect(best([{ name: 'English Voice', lang: 'en' }])).not.toBeNull();
  });

  it('returns nothing when the browser ships no voices — the headless case', () => {
    expect(best([])).toBeNull();
  });
});

describe('speakableText', () => {
  it('strips markdown emphasis rather than spelling it out', () => {
    expect(speakableText('**Nifty 50** — 24,583.80')).toBe('Nifty 50 — 24,583.80');
  });

  it('strips the trace glyphs the dock renders', () => {
    expect(speakableText('✓ Open Research')).toBe('Open Research');
    expect(speakableText('💡 Panels dock into zones')).toBe('Panels dock into zones');
    expect(speakableText('› Read 1 quote')).toBe('Read 1 quote');
  });

  it('collapses the whitespace those removals leave behind', () => {
    expect(speakableText('✓  Open   Research\n\nDone')).toBe('Open Research Done');
  });

  it('returns empty for something with nothing sayable in it', () => {
    expect(speakableText('  ✓  ')).toBe('');
  });
});
