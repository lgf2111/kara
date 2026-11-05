/**
 * How a gain gets from one value to another without a click.
 *
 * The player holds four stereo stems and mixes them with one level each; the
 * master decides whether any of that is heard at all. Every one of those five
 * numbers is a ramp rather than a jump, because a step in a gain is a step in
 * the waveform and a speaker hears it as a tick.
 *
 * The stem levels and the master use different shapes for different reasons.
 * A level is a person moving a slider, so it should feel immediate: a
 * thirty-millisecond linear ramp is short enough to read as instant and long
 * enough not to click. The master is the mode switch and the pause, and there
 * the ends matter more than the middle: a raised cosine leaves it level at
 * both ends, so a mute lands on silence rather than on the corner a linear
 * ramp would leave. A new ramp always starts from wherever the last one had
 * reached, so a change during a change is still continuous.
 *
 * Pure: the worklet reads `gainAt` once per sample and nothing here allocates.
 */

export type PlayMode = 'original' | 'instrumental';

/** Short enough to feel instant, long enough that no speaker clicks. */
export const FADE_SECONDS = 0.03;

/** A pause: short enough to read as immediate, long enough not to tick. */
export const MUTE_SECONDS = 0.02;

/**
 * How a ramp gets from one value to the other.
 *
 * - `linear`: the mode switch, where the two mixes differ by one term.
 * - `smooth`: a raised cosine, flat at both ends. For muting and fading in.
 */
export type FadeShape = 'linear' | 'smooth';

export interface GainRamp {
  readonly from: number;
  readonly to: number;
  readonly startTime: number;
  readonly seconds: number;
  readonly shape: FadeShape;
}

/**
 * Where a ramp has got to, as a fraction of the distance, when it is
 * `progress` of the way through its time. Both ends are exact.
 */
export function shapeAt(shape: FadeShape, progress: number): number {
  const at = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  // Both ends exactly, rather than a cosine's last bit of float error: a fade
  // that stops a ten-thousandth short of silence is not silence.
  if (at <= 0) {
    return 0;
  }
  if (at >= 1) {
    return 1;
  }
  switch (shape) {
    case 'linear':
      return at;
    case 'smooth':
      return 0.5 - 0.5 * Math.cos(Math.PI * at);
  }
}

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** A gain that is not going anywhere. */
export function heldGain(value: number): GainRamp {
  const at = sane(value, 0);
  return { from: at, to: at, startTime: 0, seconds: 0, shape: 'linear' };
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
  return ramp.from + (ramp.to - ramp.from) * shapeAt(ramp.shape, progress);
}

/**
 * The ramp that takes the gain to `target` from wherever it is now. A target
 * it has already reached is held rather than faded, so a repeated mode switch
 * does not keep restarting a fade that has nothing to do.
 *
 * `now` may be in the future, which is how a fade is armed: the gain stays
 * where it is until the moment the samples it will be heard with are due,
 * and moves from there.
 */
export function rampTo(
  ramp: GainRamp,
  target: number,
  now: number,
  seconds = FADE_SECONDS,
  shape: FadeShape = 'linear',
): GainRamp {
  const to = sane(target, 0);
  const from = gainAt(ramp, now);
  if (from === to || seconds <= 0) {
    return heldGain(to);
  }
  return { from, to, startTime: sane(now, 0), seconds, shape };
}
