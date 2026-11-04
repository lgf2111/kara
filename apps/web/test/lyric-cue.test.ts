import { describe, expect, it } from 'vitest';

import type { LyricLine } from '../src/library/songs.ts';
import { lastStartedBy, lyricCueAt } from '../src/player/lyric-cue.ts';

// Every word here is a placeholder. No real lyric ever goes in this repo, in a
// test or anywhere else, so the lines are spelt out of the Greek alphabet.

function line(startMs: number, endMs: number, text: string): LyricLine {
  return { startMs, endMs, text };
}

/** Three lines that meet exactly, as the reader usually writes them. */
const JOINED = [
  line(1000, 3000, 'alpha beta'),
  line(3000, 5000, 'gamma delta'),
  line(5000, 7000, 'epsilon zeta'),
];

/** The same three with silence between them, as an instrumental break. */
const SPACED = [
  line(1000, 2000, 'alpha beta'),
  line(4000, 5000, 'gamma delta'),
  line(8000, 9000, 'epsilon zeta'),
];

describe('lastStartedBy', () => {
  it('finds nothing before the first line', () => {
    expect(lastStartedBy(JOINED, 0)).toBe(-1);
    expect(lastStartedBy(JOINED, 999)).toBe(-1);
  });

  it('counts a line as started at the millisecond it starts', () => {
    expect(lastStartedBy(JOINED, 1000)).toBe(0);
    expect(lastStartedBy(JOINED, 3000)).toBe(1);
  });

  it('stays on the last line once it has started', () => {
    expect(lastStartedBy(JOINED, 6000)).toBe(2);
    expect(lastStartedBy(JOINED, 600_000)).toBe(2);
  });

  it('has nothing to find in an empty song', () => {
    expect(lastStartedBy([], 1000)).toBe(-1);
  });

  it('agrees with a scan at every millisecond of a long song', () => {
    // The point of the search: a few hundred lines is a real song, and the
    // answer has to be the same one a walk from the top would give.
    const many = Array.from({ length: 400 }, (_, index) =>
      line(index * 50, index * 50 + 40, `alpha ${String(index)}`),
    );
    for (let at = -10; at < 400 * 50 + 10; at += 7) {
      const scanned = many.reduce(
        (found, candidate, index) => (candidate.startMs <= at ? index : found),
        -1,
      );
      expect(lastStartedBy(many, at)).toBe(scanned);
    }
  });
});

describe('lyricCueAt', () => {
  it('has nothing to show for a song with no lines', () => {
    expect(lyricCueAt([], 1000)).toEqual({
      current: null,
      next: null,
      reached: null,
      index: -1,
    });
  });

  it('shows what is coming before the first line arrives', () => {
    const cue = lyricCueAt(JOINED, 0);

    expect(cue.current).toBeNull();
    expect(cue.reached).toBeNull();
    expect(cue.next).toEqual(JOINED[0]);
    expect(cue.index).toBe(-1);
  });

  it('shows the line being sung and the one after it', () => {
    const cue = lyricCueAt(JOINED, 2000);

    expect(cue.current).toEqual(JOINED[0]);
    expect(cue.next).toEqual(JOINED[1]);
    expect(cue.index).toBe(0);
  });

  it('takes a line as started on its first millisecond', () => {
    expect(lyricCueAt(JOINED, 1000).current).toEqual(JOINED[0]);
  });

  it('hands over without a blank frame where two lines meet', () => {
    // The end is exclusive and the start inclusive, so the millisecond they
    // share belongs to the line coming in.
    const cue = lyricCueAt(JOINED, 3000);

    expect(cue.current).toEqual(JOINED[1]);
    expect(cue.next).toEqual(JOINED[2]);
  });

  it('shows no line in the silence between two of them', () => {
    const cue = lyricCueAt(SPACED, 3000);

    expect(cue.current).toBeNull();
    // What just ended, which is what the overlay fades out, and what is next.
    expect(cue.reached).toEqual(SPACED[0]);
    expect(cue.next).toEqual(SPACED[1]);
    expect(cue.index).toBe(0);
  });

  it('shows no line from the moment one ends', () => {
    expect(lyricCueAt(SPACED, 2000).current).toBeNull();
  });

  it('runs out after the last line', () => {
    const cue = lyricCueAt(SPACED, 60_000);

    expect(cue.current).toBeNull();
    expect(cue.next).toBeNull();
    expect(cue.reached).toEqual(SPACED[2]);
    expect(cue.index).toBe(2);
  });

  it('still names the last line while it is being sung', () => {
    const cue = lyricCueAt(SPACED, 8500);

    expect(cue.current).toEqual(SPACED[2]);
    expect(cue.next).toBeNull();
  });

  it('gives an overlap to whichever line started last', () => {
    const overlapping = [line(1000, 5000, 'alpha beta'), line(3000, 7000, 'gamma delta')];

    expect(lyricCueAt(overlapping, 2000).current).toEqual(overlapping[0]);
    expect(lyricCueAt(overlapping, 3000).current).toEqual(overlapping[1]);
    expect(lyricCueAt(overlapping, 4999).current).toEqual(overlapping[1]);
  });

  it('does not go back to a line the next one has already replaced', () => {
    // A line wholly inside another: once the inner one has had its turn the
    // stage moves on rather than returning to the line underneath.
    const nested = [line(0, 10_000, 'alpha beta'), line(2000, 3000, 'gamma delta')];

    expect(lyricCueAt(nested, 2500).current).toEqual(nested[1]);
    expect(lyricCueAt(nested, 4000).current).toBeNull();
  });

  it('reads a clock the element has not reported yet as the start', () => {
    const cue = lyricCueAt(JOINED, Number.NaN);

    expect(cue.current).toBeNull();
    expect(cue.next).toEqual(JOINED[0]);
  });

  it('reads a negative clock as the start', () => {
    expect(lyricCueAt(JOINED, -500).next).toEqual(JOINED[0]);
  });

  it('shows the first line of a song that starts on its first word', () => {
    const immediate = [line(0, 2000, 'alpha beta')];

    expect(lyricCueAt(immediate, 0).current).toEqual(immediate[0]);
  });
});
