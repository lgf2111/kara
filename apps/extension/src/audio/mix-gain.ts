/**
 * How loud the vocal is, and how it gets from one value to another without a
 * click.
 *
 * The player holds two stems for every delayed sample, so what it plays is
 * always `instrumental + gain * vocals`. That one number is the whole of the
 * mode switch and the whole of the guide level:
 *
 * - `original` is gain 1, which adds the stems back up to the audio the tab
 *   played. htdemucs applies no mask, so the sum is the mixture to within
 *   float error, and there is no need to keep a third copy of the capture.
 * - `instrumental` is gain `guide`, from nothing at all to the quiet vocal
 *   people sing along to.
 *
 * Which also means the crossfade between modes is a ramp on a single gain
 * rather than two signals fading past each other, so it is linear: the two
 * mixes differ only in the vocal term, and anything other than linear would
 * make the vocal dip or bloom on the way across. A new ramp starts from
 * wherever the last one had reached, so a switch during a switch is still
 * continuous.
 *
 * Pure: the worklet reads `gainAt` once per sample and nothing here allocates.
 */

export type PlayMode = 'original' | 'instrumental';

/** Short enough to feel instant, long enough that no speaker clicks. */
export const FADE_SECONDS = 0.03;

export interface GainRamp {
  readonly from: number;
  readonly to: number;
  readonly startTime: number;
  readonly seconds: number;
}

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** The guide level, kept where adding it to the instrumental cannot clip. */
export function guideLevel(level: number): number {
  return Math.min(1, Math.max(0, sane(level, 0)));
}

export function vocalGainFor(mode: PlayMode, level: number): number {
  return mode === 'original' ? 1 : guideLevel(level);
}

/** A gain that is not going anywhere. */
export function heldGain(value: number): GainRamp {
  const at = sane(value, 0);
  return { from: at, to: at, startTime: 0, seconds: 0 };
}

export function gainAt(ramp: GainRamp, time: number): number {
  if (ramp.seconds <= 0) {
    return ramp.to;
  }
  const progress = (sane(time, ramp.startTime) - ramp.startTime) / ramp.seconds;
  if (progress <= 0) {
    return ramp.from;
  }
  if (progress >= 1) {
    return ramp.to;
  }
  return ramp.from + (ramp.to - ramp.from) * progress;
}

export function rampDone(ramp: GainRamp, time: number): boolean {
  return ramp.seconds <= 0 || sane(time, ramp.startTime) >= ramp.startTime + ramp.seconds;
}

/**
 * The ramp that takes the gain to `target` from wherever it is now. A target
 * it has already reached is held rather than faded, so a repeated mode switch
 * does not keep restarting a fade that has nothing to do.
 */
export function rampTo(
  ramp: GainRamp,
  target: number,
  now: number,
  seconds = FADE_SECONDS,
): GainRamp {
  const to = sane(target, 0);
  const from = gainAt(ramp, now);
  if (from === to || seconds <= 0) {
    return heldGain(to);
  }
  return { from, to, startTime: sane(now, 0), seconds };
}
