/**
 * Following the audio's place in the song, smoothly, between reports.
 *
 * The audio is the master. It says where in the song its output has reached
 * about ten times a second, and the overlay paints the frame that belongs
 * there — which is the whole of the sync, and the reason the two halves can no
 * longer drift apart however the page behaves.
 *
 * What ten reports a second cannot do is drive sixty paints a second. Painting
 * the last reported position would hold each frame for a tenth of a second and
 * then step, which reads as a stutter on a picture whose own frames arrive
 * fifteen times a second. So the position is carried forward on the wall clock
 * between reports — it advances at the rate the page is playing at, because
 * that is what the player is reading at — and each report corrects it.
 *
 * The correction is eased rather than applied. A report is a measurement, and
 * measurements wobble by a few milliseconds; snapping to each one would jitter
 * the picture back and forth across a frame boundary. Easing a fraction of the
 * error each time converges in about a second and is invisible. A large error
 * is a different event — the delay grew to catch up, or the audio was flushed
 * — and that one is taken at once, because easing a two-second jump would mean
 * two seconds of the picture being deliberately wrong.
 *
 * Pure: a state in, a state out, and the caller holds it.
 */

export interface FollowState {
  /** Where the picture believes the audio is, in media seconds. */
  readonly seconds: number;
  /** When that was true, on the wall clock, in ms. */
  readonly atMs: number;
  /** How fast the song is moving, which is the page's playback rate. */
  readonly rate: number;
}

/**
 * An error bigger than this is an event rather than a wobble, and is taken in
 * one step. Half a second is about eight frames of kept picture: far more than
 * any measurement wobbles, far less than a catch-up moves.
 */
export const SNAP_SECONDS = 0.5;

/**
 * How much of the remaining error each report takes out. At ten reports a
 * second this closes a tenth of a second of error in about a second, which is
 * slow enough to be invisible and quick enough to not be a drift.
 */
export const EASE = 0.15;

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function startFollowing(seconds: number, nowMs: number, rate = 1): FollowState {
  return {
    seconds: Math.max(0, sane(seconds, 0)),
    atMs: sane(nowMs, 0),
    rate: Math.max(0, sane(rate, 1)),
  };
}

/** Where the position has carried itself to by now. */
export function followedTo(state: FollowState, nowMs: number): number {
  const ahead = Math.max(0, sane(nowMs, state.atMs) - state.atMs) / 1000;
  return state.seconds + ahead * state.rate;
}

export interface CorrectOptions {
  readonly snapSeconds?: number;
  readonly ease?: number;
  readonly rate?: number;
}

/**
 * The state after a report. `snapped` is worth knowing: it is the picture
 * jumping, which is a thing the harness asserts on and the panel explains.
 */
export function correctFollow(
  state: FollowState,
  reportedSeconds: number,
  nowMs: number,
  options: CorrectOptions = {},
): { readonly state: FollowState; readonly snapped: boolean; readonly errorSeconds: number } {
  const at = sane(nowMs, state.atMs);
  const rate = Math.max(0, sane(options.rate ?? state.rate, state.rate));
  const reported = Math.max(0, sane(reportedSeconds, state.seconds));
  const here = followedTo(state, at);
  const error = reported - here;
  const snap = Math.max(0, sane(options.snapSeconds ?? SNAP_SECONDS, SNAP_SECONDS));
  const ease = Math.min(1, Math.max(0, sane(options.ease ?? EASE, EASE)));
  const snapped = Math.abs(error) > snap;
  return {
    state: { seconds: snapped ? reported : here + error * ease, atMs: at, rate },
    snapped,
    errorSeconds: error,
  };
}
