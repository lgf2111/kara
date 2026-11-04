import type { LyricLine } from '../library/songs.ts';

/**
 * Which line is being sung, and which one is coming, as a pure function of
 * the clock.
 *
 * A song is a few hundred lines and the clock moves four times a second, so
 * this is a binary search rather than a scan: the answer is wanted on every
 * tick of every song, and a scan would walk the whole list to say that
 * nothing has changed.
 *
 * Lines are expected in start order, which is how the reader writes them.
 * Where two of them overlap, the one that started last wins: the stage shows
 * one line at a time, and a line that has begun has replaced the one before
 * it.
 */

export interface LyricCue {
  /**
   * The line the clock is inside: `startMs` counts as in and `endMs` as out,
   * so two lines that meet exactly hand over without a blank frame. Null
   * before the first line, after the last, and in the gaps between.
   */
  readonly current: LyricLine | null;
  /** The line after the one last reached, or null once the last has started. */
  readonly next: LyricLine | null;
  /**
   * The last line to have started, whether or not it is still running. The
   * overlay keeps drawing this one while it fades, so the words leave a gap
   * softly instead of being cut off.
   */
  readonly reached: LyricLine | null;
  /** Where `reached` sits in the list, or -1 before the first line. */
  readonly index: number;
}

const NOTHING: LyricCue = { current: null, next: null, reached: null, index: -1 };

/**
 * The last line to have started by `atMs`, or -1 when none has. Expects
 * `lines` in start order.
 */
export function lastStartedBy(lines: readonly LyricLine[], atMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const line = lines[middle];
    if (line === undefined) {
      break;
    }
    if (line.startMs <= atMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function lyricCueAt(lines: readonly LyricLine[], atMs: number): LyricCue {
  if (lines.length === 0) {
    return NOTHING;
  }
  // A media element reports NaN before it has read its own metadata, which is
  // the start of the song as far as the words are concerned.
  const at = Number.isFinite(atMs) ? atMs : 0;
  const index = lastStartedBy(lines, at);
  const next = lines[index + 1] ?? null;
  const reached = index === -1 ? null : (lines[index] ?? null);

  return {
    current: reached !== null && at < reached.endMs ? reached : null,
    next,
    reached,
    index,
  };
}
