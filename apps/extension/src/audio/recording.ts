/**
 * The recorder's small state machine, its timer and its filename.
 *
 * Recording is the one part of the microphone desk with a lifecycle: a take
 * starts from a click, runs while the clock does, stops when asked or when the
 * session ends, and produces one file. Keeping that lifecycle here rather than
 * inside the offscreen document means the awkward parts — a stop while a stop
 * is already running, a failure before the first chunk, a timer that must not
 * count past the click — are a pure reducer with tests.
 *
 * The name is built rather than typed. A video id is safe to use as a stem
 * because YouTube's are already letters, digits, dashes and underscores, but
 * the function does not assume that: anything else is folded to a dash, the
 * result is capped, and a missing id becomes `performance`. The timestamp is
 * UTC so two takes cannot collide by accident and a test does not depend on
 * the machine's timezone.
 */

/** What the recorder is doing. `saving` is a stop that has not flushed yet. */
export type RecordingState = 'idle' | 'recording' | 'saving' | 'saved' | 'error';

/** The recorder's state as the panel and the status report see it. */
export interface RecordingStatus {
  readonly state: RecordingState;
  /** When the current take started, in wall-clock milliseconds. */
  readonly startedAtMs: number | null;
  /** How long the take has run, or how long it ran when it stopped. */
  readonly seconds: number;
  /** The file the take will be called, or the file the last take was called. */
  readonly filename: string | null;
  /** A failure to read, or the reason a take could not start. */
  readonly detail: string | null;
}

export const IDLE_RECORDING: RecordingStatus = {
  state: 'idle',
  startedAtMs: null,
  seconds: 0,
  filename: null,
  detail: null,
};

export type RecordingEvent =
  | { readonly type: 'start'; readonly atMs: number; readonly filename: string }
  | { readonly type: 'tick'; readonly atMs: number }
  | { readonly type: 'stop'; readonly atMs: number }
  | { readonly type: 'saved' }
  | { readonly type: 'failed'; readonly atMs: number; readonly detail: string }
  | { readonly type: 'reset' };

function elapsedSeconds(status: RecordingStatus, atMs: number): number {
  if (status.startedAtMs === null || !Number.isFinite(atMs)) {
    return status.seconds;
  }
  return Math.max(0, (atMs - status.startedAtMs) / 1000);
}

/**
 * One event applied to the recorder.
 *
 * Start is ignored while a take is already running or flushing, so a double
 * click cannot replace the file being written. Stop at any other moment is
 * ignored rather than inventing a take. A failure may arrive from any live
 * state and keeps the seconds already counted, which is what the panel shows
 * beside the error.
 */
export function nextRecording(
  status: RecordingStatus,
  event: RecordingEvent,
): RecordingStatus {
  switch (event.type) {
    case 'start':
      if (status.state === 'recording' || status.state === 'saving') {
        return status;
      }
      return {
        state: 'recording',
        startedAtMs: event.atMs,
        seconds: 0,
        filename: event.filename,
        detail: null,
      };
    case 'tick':
      return status.state === 'recording'
        ? { ...status, seconds: elapsedSeconds(status, event.atMs) }
        : status;
    case 'stop':
      if (status.state !== 'recording') {
        return status;
      }
      return {
        ...status,
        state: 'saving',
        startedAtMs: null,
        seconds: elapsedSeconds(status, event.atMs),
      };
    case 'saved':
      return status.state === 'saving'
        ? { ...status, state: 'saved', startedAtMs: null, detail: null }
        : status;
    case 'failed':
      return {
        ...status,
        state: 'error',
        startedAtMs: null,
        seconds: elapsedSeconds(status, event.atMs),
        detail: event.detail,
      };
    case 'reset':
      return IDLE_RECORDING;
  }
}

/** A score or a duration as `m:ss`, and as `h:mm:ss` once an hour is worth it. */
export function recordingTimer(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const short = `${String(minutes)}:${String(rest).padStart(2, '0')}`;
  return hours === 0 ? short : `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** A filename stem from a video id, safe on every filesystem and download API. */
export function recordingSlug(videoId: string | null | undefined): string {
  if (typeof videoId !== 'string') {
    return 'performance';
  }
  const slug = videoId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/gu, '');
  return slug === '' ? 'performance' : slug;
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** A UTC `YYYYMMDD-HHmmss` stamp, stable wherever the take was made. */
export function recordingStamp(atMs: number): string {
  const date = new Date(Number.isFinite(atMs) ? atMs : 0);
  return [
    String(date.getUTCFullYear()),
    two(date.getUTCMonth() + 1),
    two(date.getUTCDate()),
    '-',
    two(date.getUTCHours()),
    two(date.getUTCMinutes()),
    two(date.getUTCSeconds()),
  ].join('');
}

/** `kara-<video or performance>-<UTC stamp>.webm`. */
export function recordingFileName(videoId: string | null, atMs: number): string {
  return `kara-${recordingSlug(videoId)}-${recordingStamp(atMs)}.webm`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A recorder state from storage or a message, clamped rather than trusted. */
export function normaliseRecording(raw: unknown): RecordingStatus {
  const stored = recordOf(raw);
  const state: RecordingState =
    stored['state'] === 'recording' ||
    stored['state'] === 'saving' ||
    stored['state'] === 'saved' ||
    stored['state'] === 'error'
      ? stored['state']
      : 'idle';
  const started = count(stored['startedAtMs']);
  const seconds = count(stored['seconds']);
  const filename = stored['filename'];
  const detail = stored['detail'];
  return {
    state,
    startedAtMs: started !== null && started >= 0 ? started : null,
    seconds: seconds !== null && seconds > 0 ? seconds : 0,
    filename:
      typeof filename === 'string' && filename.trim() !== '' ? filename.trim() : null,
    detail: typeof detail === 'string' && detail.trim() !== '' ? detail.trim() : null,
  };
}
