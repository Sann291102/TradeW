import { describe, expect, it } from 'vitest';
import { matchesWakeWord } from './wake-word';
import { speakableText } from './speech';

/**
 * Wake-word matching is fuzzy on purpose (`AI-VOICE.md` §3): speech-to-text
 * mangles invented names constantly, and the product promises free-text names.
 * A matcher that only accepted exact transcripts would make the feature
 * unusable for exactly the names it exists to serve.
 *
 * The tension to keep an eye on is the other direction — too much tolerance and
 * the assistant wakes at every sentence, which is worse than not waking.
 */

describe('matchesWakeWord — waking', () => {
  it('matches the bare name', () => {
    expect(matchesWakeWord('Nova', 'Nova')).toBe(true);
    expect(matchesWakeWord('nova', 'Nova')).toBe(true);
  });

  it('matches the usual wake prefixes', () => {
    for (const p of ['hey', 'hi', 'hello', 'ok', 'okay']) {
      expect(matchesWakeWord(`${p} Nova`, 'Nova'), p).toBe(true);
    }
  });

  it('matches mid-sentence, since recognition prepends filler', () => {
    expect(matchesWakeWord('um hey Nova what is nifty doing', 'Nova')).toBe(true);
  });

  it('tolerates the mistranscriptions these names actually get', () => {
    expect(matchesWakeWord('hey nove', 'Nova')).toBe(true);
    expect(matchesWakeWord('hey novah', 'Nova')).toBe(true);
    expect(matchesWakeWord('hey atlast', 'Atlas')).toBe(true);
  });

  it('handles punctuation from the recogniser', () => {
    expect(matchesWakeWord('Hey, Nova!', 'Nova')).toBe(true);
  });

  it('matches multi-word names', () => {
    expect(matchesWakeWord('hey nova prime what is nifty doing', 'Nova Prime')).toBe(true);
  });
});

describe('matchesWakeWord — not waking', () => {
  it('does not wake on unrelated speech', () => {
    for (const s of [
      'what is nifty doing today',
      'the market closed lower',
      'I need to check my portfolio',
      'can you hear me',
    ]) {
      expect(matchesWakeWord(s, 'Nova'), s).toBe(false);
    }
  });

  it('keeps short names tight, where tolerance would fire constantly', () => {
    // A 3-char name gets zero edit tolerance — otherwise "max" matches "man",
    // "mad", "map", "max" and the assistant wakes at every other sentence.
    expect(matchesWakeWord('the man walked in', 'Max')).toBe(false);
    expect(matchesWakeWord('hey max', 'Max')).toBe(true);
  });

  it('does not wake on empty or missing input', () => {
    expect(matchesWakeWord('', 'Nova')).toBe(false);
    expect(matchesWakeWord('hey nova', '')).toBe(false);
    expect(matchesWakeWord('   ', 'Nova')).toBe(false);
  });

  it('treats the name as a literal, not a pattern', () => {
    // A name that looks like a regex must not be compiled as one — otherwise
    // "." matches any character and the assistant wakes on everything.
    expect(matchesWakeWord('completely unrelated speech', '.*')).toBe(false);
    expect(matchesWakeWord('anything at all here', '.')).toBe(false);
  });
});

describe('speakableText', () => {
  it('strips the markdown the assistant writes for the screen', () => {
    expect(speakableText('**Buyers** are in control')).toBe('Buyers are in control');
    expect(speakableText('• one\n• two')).toBe('one two');
    expect(speakableText('see `VWAP` here')).toBe('see VWAP here');
  });

  it('drops code blocks rather than reading them aloud', () => {
    expect(speakableText('before ```const x = 1;``` after')).toBe('before after');
  });

  it('keeps link text and drops the URL', () => {
    expect(speakableText('open [the chart](https://example.com)')).toBe('open the chart');
  });

  it('returns empty for content with nothing speakable', () => {
    expect(speakableText('   ')).toBe('');
  });
});
