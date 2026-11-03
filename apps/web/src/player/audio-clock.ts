/**
 * Where a song with no picture has reached, as arithmetic over the audio
 * clock, kept away from Web Audio so it can be tested without a browser.
 *
 * A video element answers "where are you" itself. A buffer source does not:
 * it is handed a moment on the audio device's clock and then runs, so the
 * position has to be worked out from the point it was started at and how far
 * that clock has moved since. Pausing freezes the answer, seeking moves it,
 * and neither may go off either end of the song.
 *
 * Nothing here can drift: the stems and this count the same clock.
 */

export interface AudioClock {
  /** Whether the stems are running. */
  readonly running: boolean;
  /** The point in the song the clock was last set to. */
  readonly atSeconds: number;
  /** The audio clock's reading at that moment. Idle while paused. */
  readonly sinceSeconds: number;
}

function toFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Inside the song: never before the start, never past an end we know of. */
function within(seconds: number, durationSeconds: number): number {
  const at = Math.max(0, toFinite(seconds));
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return at;
  }
  return Math.min(at, durationSeconds);
}

/** Stopped, at the start unless told otherwise. */
export function pausedClock(atSeconds = 0): AudioClock {
  return { running: false, atSeconds: Math.max(0, toFinite(atSeconds)), sinceSeconds: 0 };
}

export function clockPosition(
  clock: AudioClock,
  contextSeconds: number,
  durationSeconds: number,
): number {
  if (!clock.running) {
    return within(clock.atSeconds, durationSeconds);
  }
  // Never negative: the clock can be read in the same breath it was started.
  const elapsed = Math.max(0, toFinite(contextSeconds) - clock.sinceSeconds);
  return within(clock.atSeconds + elapsed, durationSeconds);
}

/**
 * Running, from wherever it had reached. A song sitting at its end starts
 * over, so the play button is never a button that does nothing.
 */
export function startClock(
  clock: AudioClock,
  contextSeconds: number,
  durationSeconds: number,
): AudioClock {
  const at = clockPosition(clock, contextSeconds, durationSeconds);
  const ended = Number.isFinite(durationSeconds) && durationSeconds > 0 && at >= durationSeconds;
  return { running: true, atSeconds: ended ? 0 : at, sinceSeconds: toFinite(contextSeconds) };
}

export function pauseClock(
  clock: AudioClock,
  contextSeconds: number,
  durationSeconds: number,
): AudioClock {
  return {
    running: false,
    atSeconds: clockPosition(clock, contextSeconds, durationSeconds),
    sinceSeconds: toFinite(contextSeconds),
  };
}

/** Moved, and still running if it was: dragging the bar is not a pause. */
export function seekClock(
  clock: AudioClock,
  seconds: number,
  contextSeconds: number,
  durationSeconds: number,
): AudioClock {
  return {
    running: clock.running,
    atSeconds: within(seconds, durationSeconds),
    sinceSeconds: toFinite(contextSeconds),
  };
}

/**
 * Whether the song has run out. A length we do not know yet cannot have been
 * reached, which is what keeps a loading song from stopping itself.
 */
export function clockEnded(
  clock: AudioClock,
  contextSeconds: number,
  durationSeconds: number,
): boolean {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return false;
  }
  return clockPosition(clock, contextSeconds, durationSeconds) >= durationSeconds;
}
