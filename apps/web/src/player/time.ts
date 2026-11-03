import { formatDuration } from '../library/format.ts';

/**
 * The arithmetic behind the player's controls, kept away from the elements so
 * it can be tested without a browser. A media element reports times in
 * seconds, and reports them as NaN until it has read the file's metadata, so
 * every one of these has to survive a number that is not there yet.
 */

/** Seconds the arrow keys move by. */
export const SKIP_SECONDS = 5;

/** Steps the up and down keys move the volume by. */
export const VOLUME_STEP = 0.1;

/**
 * A clock reading for a time or a length. An unknown length reads as dashes
 * rather than 0:00, which would claim the song is empty.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  return formatDuration(seconds * 1000);
}

/**
 * Where a skip lands. Never before the start, and never past the end once the
 * end is known; while it is unknown the browser clamps it for us.
 */
export function seekTo(currentSeconds: number, deltaSeconds: number, durationSeconds: number): number {
  const target = Math.max(0, (Number.isFinite(currentSeconds) ? currentSeconds : 0) + deltaSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return target;
  }
  return Math.min(target, durationSeconds);
}

/** A volume the element will accept: 0 to 1, and never NaN. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
