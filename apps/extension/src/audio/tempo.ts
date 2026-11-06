/**
 * Playback-rate sync: how fast the stems read, and what the shifter has to do
 * so that speed does not change the key.
 *
 * The video owns the clock, including its speed. The player reads the stems at
 * the rate the page is playing at — a head that advances `rate` source frames
 * per output frame — which is exactly what a resampler does, so on its own it
 * would transpose the song by the same ratio. The Signalsmith Stretch node
 * after the player puts the key back: reading at `rate` raises the pitch by
 * `12 * log2(rate)` semitones, so the compensation is its negation. The
 * person's chosen key is added on top, which is why a song at 1.5× and key +2
 * comes out at +2, not at whatever the speed alone would have done.
 *
 * YouTube's menu runs from 0.25× to 2×. Those are the rates the player can
 * follow; outside that the video's own sound is the honest one, and the page's
 * mute and the engine's follow gate both ask the same question so they cannot
 * disagree about it.
 *
 * Pure, so the arithmetic is the test.
 */

/** The slowest video speed the player follows, in the page's own units. */
export const TEMPO_MIN_RATE = 0.25;

/** The fastest. YouTube tops out at 2×, and so does this. */
export const TEMPO_MAX_RATE = 2;

/** Whether the stems can read at this rate and stay in step with the video. */
export function canFollowTempo(rate: unknown): rate is number {
  return (
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate >= TEMPO_MIN_RATE &&
    rate <= TEMPO_MAX_RATE
  );
}

/**
 * The pitch shift, in semitones, that cancels a playback rate.
 *
 * Negative because reading faster raises pitch: 2× is one octave up, so the
 * shifter goes one octave down. An invalid rate has no ratio to cancel.
 */
export function pitchOffsetForRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) {
    return 0;
  }
  return -12 * Math.log2(rate);
}

/**
 * The shifter's one setting: the chosen key plus the speed's compensation.
 *
 * They are one number because the node applies one number. Adding them here
 * rather than in two scheduled changes means the key and the tempo can never
 * be applied a message apart, which would be a moment of the wrong pitch.
 */
export function pitchSemitonesForKey(key: number, rate: number): number {
  return key + pitchOffsetForRate(rate);
}
