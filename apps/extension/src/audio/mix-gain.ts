/**
 * How loud the vocal is, and how it gets from one value to another without a
 * click.
 *
 * The player holds two stems for every delayed sample, so what it plays is
 * always `(instrumental + gain * vocals) * master`. That first number is the
 * whole of the mode switch and the whole of the guide level:
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
 * The master gain is the other three movements, and they are not linear.
 *
 * - **A pause** mutes in twenty milliseconds and unmutes in the same, on a
 *   raised cosine, because a linear ramp that short leaves a corner in the
 *   waveform and a corner is a tick.
 * - **Going live from silence** fades the delayed mix up over about three
 *   quarters of a second, on the same curve, so that the song arrives rather
 *   than starting mid-sample.
 * - **Going live from the tab's own audio** is a crossfade, and that one has
 *   to be equal power: two uncorrelated signals passing each other on linear
 *   ramps dip by three decibels in the middle, which is audible as a hole.
 *   `sin` up against `cos` down keeps the sum of squares at one.
 *
 * Pure: the worklet reads `gainAt` once per sample and nothing here allocates.
 */

export type PlayMode = 'original' | 'instrumental';

/** Short enough to feel instant, long enough that no speaker clicks. */
export const FADE_SECONDS = 0.03;

/** A pause: short enough to read as immediate, long enough not to tick. */
export const MUTE_SECONDS = 0.02;

/** Silence to the delayed mix, when nothing was audible before it. */
export const FADE_IN_SECONDS = 0.7;

/** The tab's own audio to the delayed mix, which is two ramps at once. */
export const CROSSFADE_SECONDS = 0.8;

/**
 * How a ramp gets from one value to the other.
 *
 * - `linear`: the mode switch, where the two mixes differ by one term.
 * - `smooth`: a raised cosine, flat at both ends. For muting and fading in.
 * - `power-in` and `power-out`: one half each of an equal-power crossfade.
 */
export type FadeShape = 'linear' | 'smooth' | 'power-in' | 'power-out';

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
    case 'power-in':
      return Math.sin((Math.PI / 2) * at);
    case 'power-out':
      return 1 - Math.cos((Math.PI / 2) * at);
  }
}

/**
 * The two gains of an equal-power crossfade at one instant: what is arriving
 * and what is leaving. `arriving² + leaving² === 1`, which is what keeps the
 * loudness flat across the middle.
 */
export function crossfadeGains(progress: number): {
  readonly arriving: number;
  readonly leaving: number;
} {
  const at = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return {
    arriving: Math.sin((Math.PI / 2) * at),
    leaving: Math.cos((Math.PI / 2) * at),
  };
}

/** Points in a curve handed to `setValueCurveAtTime`: dense enough to be smooth. */
export const CURVE_POINTS = 129;

/**
 * The leaving half of that crossfade, sampled for a Web Audio gain node. The
 * worklet's master gain takes the arriving half as a `power-in` ramp, so the
 * two are the same curve read from opposite ends.
 */
export function crossfadeOutCurve(points = CURVE_POINTS): Float32Array {
  const count = Number.isFinite(points) ? Math.max(2, Math.round(points)) : CURVE_POINTS;
  const curve = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    curve[index] = crossfadeGains(index / (count - 1)).leaving;
  }
  return curve;
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

export function rampDone(ramp: GainRamp, time: number): boolean {
  return ramp.seconds <= 0 || sane(time, ramp.startTime) >= ramp.startTime + ramp.seconds;
}

/**
 * The ramp that takes the gain to `target` from wherever it is now. A target
 * it has already reached is held rather than faded, so a repeated mode switch
 * does not keep restarting a fade that has nothing to do.
 *
 * `now` may be in the future, which is how the fade in is armed: the gain
 * stays where it is until the moment the first delayed sample is due, and
 * moves from there.
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
