/**
 * Whether the video's own clock jumped, or whether it is just doing what a
 * playing video does.
 *
 * This exists because `seeking` is not the question. The page fires `seeking`
 * for a scrub, which is a jump, and also while it is buffering, when it adopts
 * a new source, when a quality change reloads the stream, and at the start of
 * playback — none of which move the person anywhere. Treating every one of
 * them as a jump means throwing the separated buffer away and priming the
 * whole delay again, which is the cost this file exists to avoid paying by
 * accident.
 *
 * So the test is arithmetic rather than an event name. A playing video's clock
 * advances by the wall time that went by, times the rate; a paused one does
 * not advance at all. Either way, where it should be is known, and a jump is
 * the video being somewhere else by more than a threshold.
 *
 * The threshold is a judgement. Too small and a stutter, a dropped frame or a
 * timestamp read a little late counts as a seek; too large and a short nudge
 * on the arrow keys is missed, which costs nothing worse than the picture
 * being a second out until the next real event. Three quarters of a second is
 * comfortably more than the sampling interval's worth of slack and comfortably
 * less than the five seconds an arrow key moves.
 *
 * Pure, so it can be tested on numbers rather than on a video.
 */

/** Where the video's clock was at one instant, and how fast it was moving. */
export interface TimelinePoint {
  /** `video.currentTime`, in seconds. */
  readonly mediaSeconds: number;
  /** When that was read, on any clock, as long as it is always the same one. */
  readonly wallMs: number;
  readonly rate: number;
  readonly paused: boolean;
}

/** More than a sample's worth of slack, less than one press of an arrow key. */
export const SEEK_THRESHOLD_SECONDS = 0.75;

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Where the video's clock should have got to by `wallMs`, given where it was.
 * A paused video should be exactly where it was left.
 */
export function expectedMediaSeconds(from: TimelinePoint, wallMs: number): number {
  const elapsed = Math.max(0, sane(wallMs, from.wallMs) - sane(from.wallMs, 0)) / 1000;
  const rate = from.paused ? 0 : Math.max(0, sane(from.rate, 1));
  return sane(from.mediaSeconds, 0) + elapsed * rate;
}

/**
 * Whether the video is somewhere nobody played it to, which is what a seek is
 * and what every other reason for a `seeking` event is not.
 *
 * **The test is directional, and that is the repair.** It used to be the
 * distance from where the clock should have got to, either way, which made a
 * buffering stall indistinguishable from a seek: a video that plays for two
 * seconds of wall time and advances by nothing is two seconds short of
 * expected, so a connection having a bad minute read as a scrub every time and
 * cost the whole delay for it. But falling behind and being somewhere else are
 * not the same thing. A stall can leave the clock anywhere between where it
 * was and where it was going; it can never put it past where it was going, and
 * it can never move it backwards. So those two are the seek:
 *
 * - ahead of where playing could have taken it, by more than the threshold
 * - behind where it already was, by more than the threshold
 *
 * and everything in between — including a video that moved by nothing at all —
 * is the page doing what pages do.
 *
 * With no earlier point to compare against — the first event after a mount —
 * the answer is no. Priming again is the expensive answer, and an unprovoked
 * one at the moment the panel appears is the worst time to pay for it.
 */
export function isRealSeek(
  from: TimelinePoint | null,
  to: TimelinePoint,
  thresholdSeconds = SEEK_THRESHOLD_SECONDS,
): boolean {
  if (from === null) {
    return false;
  }
  const expected = expectedMediaSeconds(from, to.wallMs);
  const threshold = Math.max(0, sane(thresholdSeconds, SEEK_THRESHOLD_SECONDS));
  const now = sane(to.mediaSeconds, expected);
  const was = sane(from.mediaSeconds, expected);
  return now > expected + threshold || now < Math.min(was, expected) - threshold;
}
