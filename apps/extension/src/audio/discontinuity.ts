/**
 * Whether the song moved somewhere nobody played it to.
 *
 * This is the one question that decides a reset, and it used to be answered by
 * an event name. The page fires `seeking` for a scrub — which is a jump — and
 * also while buffering, when it adopts a new source, when a quality change
 * reloads the stream and at the start of playback, none of which move anybody
 * anywhere. Obeying all of them cost the whole eighteen-second delay for
 * nothing, repeatedly, on a connection having a bad minute.
 *
 * So the question is asked of media time instead, and of the processed
 * timeline rather than of the wall clock. The capture that reaches the
 * separator is only the capture taken while the song was moving, so the song
 * position the next chunk *should* carry is exactly where the last kept chunk
 * ended — a pause, a stall, an ad and a buffering wait all leave that
 * untouched, because the audio captured through them is discarded instead of
 * separated. Which leaves three answers and no ambiguity:
 *
 * - **standing still**: the song barely moved across this chunk. Paused,
 *   buffering, waiting, stalled, or an ad with its own timeline. Discard the
 *   audio; the timeline is unharmed.
 * - **jumped**: the song is somewhere else by more than the threshold, and no
 *   amount of standing still explains being somewhere *else*. That is a real
 *   seek and everything in flight belongs to the old timeline.
 * - **continuous**: carry on.
 *
 * The threshold is a judgement. Too small and a frame read a little late, or a
 * quarter of a second of interpolation slack, counts as a seek; too large and
 * a short nudge of the arrow keys is missed, which costs nothing worse than
 * the picture being a second out until the next real event. Three quarters of
 * a second is comfortably more than the sampling slack and comfortably less
 * than the five seconds an arrow key moves — the same number, for the same
 * reasons, as the page side's own judgement in `content/timeline.ts`.
 *
 * Pure, so a stall is four numbers.
 */

/** More than a sample's worth of slack, less than one press of an arrow key. */
export const JUMP_SECONDS = 0.75;

/**
 * How much of a chunk's worth of song has to have gone by for the page to
 * have been moving at all. A quarter: a chunk is 93 ms, so this calls anything
 * under about 23 ms of movement a stall, which no playing video ever is.
 */
export const MOVING_FRACTION = 0.25;

export type Continuity = 'continuous' | 'standing-still' | 'jumped';

export interface ContinuityFacts {
  /**
   * Where the processed timeline says the next audio should be, in media
   * seconds: where the last kept chunk ended.
   */
  readonly expectedSeconds: number;
  /** Where the page says this chunk actually starts. */
  readonly actualSeconds: number;
  /** How far the song moved across the chunk. */
  readonly advancedSeconds: number;
  /** How much song a chunk of this length covers at the page's rate. */
  readonly chunkSeconds: number;
  readonly jumpSeconds?: number;
}

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function decideContinuity(facts: ContinuityFacts): Continuity {
  const chunkSeconds = Math.max(0, sane(facts.chunkSeconds, 0));
  const advanced = sane(facts.advancedSeconds, 0);
  if (advanced < chunkSeconds * MOVING_FRACTION) {
    // Standing still is checked first and wins: a page that is not moving
    // through the song cannot have jumped, whatever its clock reads.
    return 'standing-still';
  }
  const threshold = Math.max(0, sane(facts.jumpSeconds ?? JUMP_SECONDS, JUMP_SECONDS));
  const expected = sane(facts.expectedSeconds, 0);
  const actual = sane(facts.actualSeconds, expected);
  return Math.abs(actual - expected) > threshold ? 'jumped' : 'continuous';
}
