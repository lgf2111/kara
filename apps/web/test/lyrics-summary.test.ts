import { describe, expect, it } from 'vitest';

import { describeLyrics, formatReadDate, lineSpan } from '../src/library/lyrics-summary.ts';
import type { LyricLine, SongLyrics } from '../src/library/songs.ts';

/** Placeholder words: no real lyric belongs in this repo. */
const LINES: LyricLine[] = [
  { startMs: 5_000, endMs: 7_500, text: 'alpha bravo' },
  { startMs: 8_000, endMs: 11_000, text: 'charlie delta' },
  { startMs: 12_000, endMs: 201_400, text: 'echo foxtrot' },
];

const lyrics = (lines: readonly LyricLine[], readAt = '2026-11-03T09:14:02.000Z'): SongLyrics => ({
  lines,
  source: 'video-ocr',
  readAt,
});

describe('lineSpan', () => {
  it('covers the earliest start to the latest end', () => {
    expect(lineSpan(LINES)).toEqual({ startMs: 5_000, endMs: 201_400 });
  });

  it('does not trust the stored order', () => {
    expect(lineSpan([...LINES].reverse())).toEqual({ startMs: 5_000, endMs: 201_400 });
  });

  it('is nothing for no lines', () => {
    expect(lineSpan([])).toBeNull();
  });

  it('handles the one-line case', () => {
    expect(lineSpan([LINES[0] as LyricLine])).toEqual({ startMs: 5_000, endMs: 7_500 });
  });
});

describe('formatReadDate', () => {
  it('reads as a day', () => {
    expect(formatReadDate('2026-11-03T09:14:02.000Z')).toBe('3 Nov 2026');
    expect(formatReadDate('2026-01-31T00:00:00.000Z')).toBe('31 Jan 2026');
    expect(formatReadDate('2025-12-09T23:59:59.000Z')).toBe('9 Dec 2025');
  });

  it('says so when the timestamp is not one', () => {
    expect(formatReadDate('')).toBe('an unknown date');
    expect(formatReadDate('last tuesday')).toBe('an unknown date');
    expect(formatReadDate('2026-13-01T00:00:00.000Z')).toBe('an unknown date');
  });
});

describe('describeLyrics', () => {
  it('counts the lines, the stretch they cover and when they were read', () => {
    expect(describeLyrics(lyrics(LINES))).toBe('3 lyric lines · 0:05 to 3:21 · read 3 Nov 2026');
  });

  it('counts one line as one line', () => {
    expect(describeLyrics(lyrics([LINES[0] as LyricLine]))).toBe(
      '1 lyric line · 0:05 to 0:08 · read 3 Nov 2026',
    );
  });

  it('leaves the stretch out when there is nothing to cover', () => {
    expect(describeLyrics(lyrics([]))).toBe('0 lyric lines · read 3 Nov 2026');
  });

  it('carries no lyric text', () => {
    const summary = describeLyrics(lyrics(LINES));
    for (const line of LINES) {
      expect(summary).not.toContain(line.text);
    }
  });
});
