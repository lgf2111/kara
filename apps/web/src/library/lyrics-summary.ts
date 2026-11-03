import { formatDuration } from './format.ts';
import type { LyricLine, SongLyrics } from './songs.ts';

/**
 * What the collapsed lyrics section says about the lines without showing
 * them. The lines are the person's own reading of their own video, so the
 * summary carries counts and times only, and the words stay behind the
 * disclosure they open themselves.
 */

export interface LyricSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The stretch of the song the lines cover. Taken as the earliest start and
 * the latest end rather than the first and last line, because nothing
 * promises the stored order is the sung order.
 */
export function lineSpan(lines: readonly LyricLine[]): LyricSpan | null {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const line of lines) {
    startMs = Math.min(startMs, line.startMs);
    endMs = Math.max(endMs, line.endMs);
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The day a read was saved, from the date part of the stored timestamp.
 *
 * Read off the string rather than through `Date`, so the answer does not
 * depend on the clock the page happens to be running under. The timestamp is
 * written in UTC, so a read just before midnight local time can read as the
 * next day; a date is all this needs to say.
 */
export function formatReadDate(readAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(readAt);
  if (match === null) {
    return 'an unknown date';
  }
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) {
    return 'an unknown date';
  }
  return `${String(Number(match[3]))} ${month} ${String(match[1])}`;
}

/** The summary line: how many, over what stretch, and when they were read. */
export function describeLyrics(lyrics: SongLyrics): string {
  const count = lyrics.lines.length;
  const counted = `${String(count)} lyric ${count === 1 ? 'line' : 'lines'}`;
  const span = lineSpan(lyrics.lines);
  const covered =
    span === null
      ? null
      : `${formatDuration(span.startMs)} to ${formatDuration(span.endMs)}`;
  return [counted, covered, `read ${formatReadDate(lyrics.readAt)}`]
    .filter((part) => part !== null)
    .join(' · ');
}
