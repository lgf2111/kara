import { isVideoId } from '../stream/player.ts';

/**
 * The scores this machine has sung, and the arithmetic that keeps them.
 *
 * This is not a song library. YouTube already owns the history and the
 * favourites; all that is kept here is one small record per completed practice
 * run, so a score survives a closed tab and can be put on a score card. No
 * audio, no video, no timestamps inside the song: just the result and enough
 * words to remember which song it was.
 *
 * Everything here is pure. The storage half is `practice/score-store.ts`; the
 * drawing half is `practice/score-card.ts`, which turns one of these records
 * into a layout. Storage may hold records written by an older version, so the
 * parse below is deliberately suspicious of every field and drops what it
 * cannot recognise rather than showing a made-up score.
 */

/** One completed practice run, as it is kept on this machine. */
export interface PracticeRun {
  readonly videoId: string;
  readonly title: string;
  /** The channel or artist the page showed, when it showed one. */
  readonly artist: string | null;
  /** An optional name for the score card. */
  readonly singer: string | null;
  /** Nought to a hundred, the same scale as the end card. */
  readonly score: number;
  readonly accuracy: number;
  readonly notesHit: number;
  readonly notesTotal: number;
  readonly longestStreak: number;
  /** When the run ended, in epoch milliseconds. */
  readonly at: number;
}

/** One storage key holding the whole history, so a write is never half a read. */
export const SCORE_HISTORY_KEY = 'kara.practice.scores';

/** The optional singer name, kept separately from the records it applies to. */
export const SCORE_SINGER_KEY = 'kara.practice.singer';

/** Enough history to be useful, small enough that a read stays cheap. */
export const MAX_SCORE_HISTORY = 200;

export const MAX_TITLE_LENGTH = 120;
export const MAX_ARTIST_LENGTH = 80;
export const MAX_SINGER_LENGTH = 40;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A trimmed, single-line string, or null for nothing useful. */
function textOrNull(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.replace(/\s+/gu, ' ').trim();
  return text === '' ? null : text.slice(0, limit).trim();
}

/** Epoch milliseconds from a number or an ISO date, or null when unreadable. */
function timeOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * One record out of whatever storage had, or null when it is not a score.
 *
 * A record needs a video id, a title, a date and at least one guide note;
 * everything else is clamped into range. Missing optional words become null,
 * which is what the score card draws as no line at all.
 */
export function normaliseScoreRun(raw: unknown): PracticeRun | null {
  const stored = recordOf(raw);
  const videoId = stored['videoId'];
  const title = textOrNull(stored['title'], MAX_TITLE_LENGTH);
  const at = timeOrNull(stored['at']);
  const notesTotal = Math.max(0, Math.round(numberOrNull(stored['notesTotal']) ?? 0));
  if (!isVideoId(videoId) || title === null || at === null || notesTotal === 0) {
    return null;
  }
  const notesHit = clamp(
    Math.round(numberOrNull(stored['notesHit']) ?? 0),
    0,
    notesTotal,
  );
  return {
    videoId,
    title,
    artist: textOrNull(stored['artist'], MAX_ARTIST_LENGTH),
    singer: textOrNull(stored['singer'], MAX_SINGER_LENGTH),
    score: clamp(numberOrNull(stored['score']) ?? 0, 0, 100),
    accuracy: clamp(numberOrNull(stored['accuracy']) ?? 0, 0, 100),
    notesHit,
    notesTotal,
    longestStreak: clamp(
      Math.round(numberOrNull(stored['longestStreak']) ?? 0),
      0,
      notesTotal,
    ),
    at,
  };
}

/** A history with malformed records dropped, newest first, and capped. */
export function normaliseScoreHistory(raw: unknown): PracticeRun[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const runs: PracticeRun[] = [];
  for (const item of raw) {
    const run = normaliseScoreRun(item);
    if (run !== null) {
      runs.push(run);
    }
  }
  return pruneScoreHistory(runs);
}

/** Newest first, with the oldest dropped once `max` records are kept. */
export function pruneScoreHistory(
  records: readonly PracticeRun[],
  max: number = MAX_SCORE_HISTORY,
): PracticeRun[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : MAX_SCORE_HISTORY;
  return [...records]
    .sort((left, right) => {
      if (right.at !== left.at) {
        return right.at - left.at;
      }
      return left.videoId.localeCompare(right.videoId);
    })
    .slice(0, limit);
}

/** A new run in front of the old ones, with the oldest trimmed away. */
export function appendScoreRun(
  history: readonly PracticeRun[],
  run: PracticeRun,
  max: number = MAX_SCORE_HISTORY,
): PracticeRun[] {
  return pruneScoreHistory([run, ...history], max);
}

/** The most recent runs, newest first. */
export function recentRuns(records: readonly PracticeRun[], limit = 5): PracticeRun[] {
  return pruneScoreHistory(records, limit);
}

function better(left: PracticeRun, right: PracticeRun): boolean {
  if (Math.abs(left.score - right.score) > 1e-9) {
    return left.score > right.score;
  }
  if (Math.abs(left.accuracy - right.accuracy) > 1e-9) {
    return left.accuracy > right.accuracy;
  }
  return left.at > right.at;
}

/**
 * The best score for each song, best first.
 *
 * A song is a video id, not a title: the same title can be a different
 * recording, and the page can change its title between runs. Ties go to the
 * more accurate run, then to the newer one, so the list never reshuffles for
 * no reason.
 */
export function bestScores(records: readonly PracticeRun[], limit = 5): PracticeRun[] {
  const best = new Map<string, PracticeRun>();
  for (const run of records) {
    const current = best.get(run.videoId);
    if (current === undefined || better(run, current)) {
      best.set(run.videoId, run);
    }
  }
  return [...best.values()]
    .sort((left, right) => (better(left, right) ? -1 : better(right, left) ? 1 : 0))
    .slice(0, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0);
}

/** `6 Nov 2026`, in UTC so the same record reads the same everywhere. */
export function formatRunDate(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(at) || Number.isNaN(date.getTime())) {
    return '—';
  }
  const month = MONTHS[date.getUTCMonth()] ?? '—';
  return `${String(date.getUTCDate())} ${month} ${String(date.getUTCFullYear())}`;
}

/** The singer name as storage should hold it: one line, trimmed, bounded. */
export function normaliseSinger(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  const name = raw.replace(/\s+/gu, ' ').trim();
  return name.slice(0, MAX_SINGER_LENGTH).trim();
}
