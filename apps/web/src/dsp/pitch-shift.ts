import { realTransform } from './fft.ts';
import { hannPeriodic } from './stft.ts';

/**
 * Changing the key without changing the tempo, on a stream, at a latency that
 * never moves.
 *
 * A phase vocoder: the signal is cut into overlapping frames, each one
 * transformed, its partials moved by the pitch ratio, and the frames added
 * back up. Nothing here is new; what is worth reading is which of the several
 * ways of arranging it this one is, and why.
 *
 * **It is one pass at a constant rate, not a stretch and a resample.** The
 * textbook pitch shifter time-stretches by the ratio and then resamples back,
 * which is two stages running at different sample rates with a buffer between
 * them — and the fill of that buffer depends on the ratio, so the latency
 * moves when the key moves. That is the one thing this cannot do: the picture
 * is delayed to meet the audio by a number fixed when the capture started, and
 * audio that slides forwards by thirty milliseconds when somebody presses a
 * key button slides out of the mouth it is coming from. So the two stages are
 * collapsed into one, the way they can be: analyse at hop `HOP`, move each
 * partial's magnitude to `bin × ratio` and advance its phase by `ratio ×` its
 * measured frequency, and synthesise at the same hop `HOP`. Output and input
 * are the same length by construction, there is no intermediate rate, and the
 * latency is one frame whatever the ratio is. It is the same mathematics as
 * stretch-then-resample, folded together.
 *
 * **Identity phase locking, so that transients and tonal peaks survive.**
 * Advancing every bin's phase on its own is what makes a plain phase vocoder
 * sound like a phase vocoder: the bins of one partial drift out of step with
 * each other and a struck note turns to mush. Puckette's trick is to find the
 * peaks of the magnitude spectrum, give each peak the only phase accumulator
 * in its region, and then put every other bin in that region back at the phase
 * it had *relative to its peak in this frame*. One rotation does a whole
 * region, which is why it costs almost nothing: the contribution of bin `k` is
 * its own complex value turned by `exp(i(accumulated − measured))` of its
 * peak. No `atan2` per bin, no magnitude array, two multiply-adds per bin.
 *
 * **At a ratio of one it is exactly the identity**, which is what makes
 * switching the shift on and off safe. The accumulators are started from the
 * first frame's own phases and advance by each peak's measured phase advance,
 * so at ratio one the rotation is unity and the chain is a windowed
 * analysis-synthesis round trip, which Hann at a quarter-frame hop reconstructs
 * perfectly. The shifter can therefore be crossfaded against its own bypass
 * while the ratio glides towards one, and neither end of the crossfade is
 * audible.
 *
 * **Zero semitones is bypassed, and still delayed by exactly
 * `latencySamples`.** Not for the cycles — for the sync. Toggling transpose
 * must not move the audio relative to the delayed picture by a single sample,
 * so both paths read the same ring at the same offset and the only difference
 * is whether the frames were rebuilt on the way. Which also means the untouched
 * path is bit-for-bit the input, delayed, rather than nearly it.
 *
 * **Nothing is allocated once it is running.** Every buffer, window and
 * accumulator is made when the shifter is, blocks of any size are taken a
 * `CHUNK` at a time so the rings never need to grow, and the transforms come
 * from `fft.ts`, which allocates per size and not per call. It is meant to be
 * called from an `AudioWorkletProcessor` with a hundred and twenty-eight
 * frames at a time.
 *
 * What it is not good at is in `docs/extension.md` under limits, and it is the
 * honest reason `QUALITY_SEMITONES` is six rather than the two octaves the
 * arithmetic would take: a frame of 2048 samples smears a transient across
 * forty-six milliseconds, and the further the partials are moved the more of
 * the synthesis spectrum is gaps the magnitudes were stretched over, which is
 * what large shifts hear as hollow.
 */

/** The analysis and synthesis frame: about 46 ms at 44.1 kHz. */
const FRAME = 2048;

/** A quarter of it, which is where Hann against Hann sums to a constant. */
const HOP = 512;

/**
 * Samples between a sample arriving and the same moment leaving.
 *
 * An output sample is only finished once every frame covering it has been
 * added, and the last of those is the frame that starts on it, which needs a
 * whole frame of input beyond it. So the wait is one frame, and the same one
 * frame whether anything was shifted or not.
 */
const LATENCY = FRAME;

/** The rings: the live frame, a chunk of slack, and a power of two. */
const RING = 8192;
const MASK = RING - 1;

/**
 * Input taken at a time. Chunking is what lets `process` be handed a block of
 * any length — a thousand frames or four — without a buffer having to grow.
 */
const CHUNK = HOP;

/** Below this much power a bin is noise and cannot be a peak. */
const POWER_FLOOR = 1e-18;

/**
 * And below this much of the loudest bin in the frame either, which is a
 * hundred decibels down.
 *
 * Without it the window's own leakage is picked up as hundreds of peaks a
 * frame, each one costing a rotation to place something nobody can hear. A
 * floor relative to the frame rather than to full scale is what keeps a quiet
 * passage working the same as a loud one.
 */
const RELATIVE_FLOOR = 1e-10;

/**
 * How many bins either side a peak has to beat to be one.
 *
 * One would do, and it is what the textbook says, but a Hann main lobe is
 * three bins wide and its first sidelobe is only thirty decibels down: taking
 * every local maximum makes a region out of each shoulder of every partial,
 * which is both a waste and a way to let a partial's own skirts drift out of
 * step with it. Two bins keeps the lobe together, and it guarantees peaks are
 * three apart, which is what lets a peak be carried on from a neighbouring
 * bin without reading another peak's accumulator.
 */
const PEAK_SPREAD = 2;

const TWO_PI = Math.PI * 2;

/**
 * As far as the arithmetic stays sane, which is two octaves either way. This
 * is a guard against a number nobody meant rather than a judgement about
 * which keys are worth offering.
 */
export const MIN_SEMITONES = -24;
export const MAX_SEMITONES = 24;

/**
 * How far it is worth offering, which is a different question and a matter of
 * taste rather than of range. Past about half an octave a phase vocoder is
 * audibly hollow — more of the synthesis spectrum is gaps the magnitudes were
 * stretched over than is signal — so the extension's key control stops here
 * and `apps/extension/src/audio/key.ts` holds it to the same number.
 */
export const QUALITY_SEMITONES = 6;

/**
 * How long a change takes to arrive. The ratio glides and, when the shift is
 * being switched on or off, the bypass crossfades, both over this.
 *
 * It is longer than a frame on purpose. A vocoder that has just started has
 * only part of its overlap, so its first frame comes out quiet; by holding the
 * crossfade at nothing for a frame before starting it, the quiet part is never
 * mixed in and the only thing the ear gets is a short slide.
 */
export const GLIDE_SECONDS = 0.12;

export interface PitchShifterOptions {
  readonly channels: number;
  readonly sampleRate: number;
  /** Where to start. Zero, which is the bypass, by default. */
  readonly semitones?: number;
}

export interface PitchShifter {
  readonly channels: number;
  readonly sampleRate: number;
  /**
   * Samples between going in and coming out. Constant: the same number at no
   * shift as at any shift, so turning transpose on cannot move the audio
   * relative to anything that was lined up with it.
   */
  readonly latencySamples: number;
  /** The last thing asked for, clamped to the range. */
  readonly semitones: number;
  /** Asks for a new key. Takes effect over `GLIDE_SECONDS`, without a click. */
  setSemitones(semitones: number): void;
  /**
   * One block, in and out, one array per channel. In place is allowed: the
   * input is taken before the output is written. `frames` is how much of the
   * arrays to use, and defaults to the whole of the first output channel.
   */
  process(
    input: readonly Float32Array[],
    output: readonly Float32Array[],
    frames?: number,
  ): void;
  /** Empties everything, keeping the key. For a seek, or a new timeline. */
  reset(): void;
}

/** A key inside the range, in whole or fractional semitones. */
export function clampSemitones(semitones: number): number {
  if (!Number.isFinite(semitones)) {
    return 0;
  }
  return Math.min(MAX_SEMITONES, Math.max(MIN_SEMITONES, semitones));
}

/** How much to multiply a frequency by, for a shift in semitones. */
export function pitchRatio(semitones: number): number {
  return Math.pow(2, clampSemitones(semitones) / 12);
}

/** An angle brought back into (−π, π]. */
function principal(angle: number): number {
  return angle - TWO_PI * Math.round(angle / TWO_PI);
}

export function createPitchShifter(options: PitchShifterOptions): PitchShifter {
  const channels = Math.max(1, Math.round(options.channels));
  const sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
  const transform = realTransform(FRAME);
  const bins = transform.bins;
  const window = hannPeriodic(FRAME);

  /**
   * What the squared window sums to where the frames overlap, which is what
   * the overlap-add has to be divided by to come back at the right level.
   * Measured off the window rather than written down as 1.5, so that changing
   * the frame or the hop cannot quietly change the gain.
   */
  let cola = 0;
  for (let step = 0; step < FRAME / HOP; step += 1) {
    const value = window[step * HOP] ?? 0;
    cola += value * value;
  }
  const norm = cola > 0 ? 1 / cola : 1;

  /** Per channel: the input, delayed, and the frames added back up. */
  const dryRings = Array.from({ length: channels }, () => new Float32Array(RING));
  const wetRings = Array.from({ length: channels }, () => new Float32Array(RING));
  /** Last frame's spectrum, for each peak's phase advance without an atan2. */
  const lastRe = Array.from({ length: channels }, () => new Float64Array(bins));
  const lastIm = Array.from({ length: channels }, () => new Float64Array(bins));
  /** Each peak's running synthesis phase, kept at the peak's own bin. */
  const phases = Array.from({ length: channels }, () => new Float64Array(bins));
  /** Which bins were peaks last frame, so a peak that moved is carried on. */
  const peaked = Array.from({ length: channels }, () => new Uint8Array(bins));

  const frame = new Float64Array(FRAME);
  const re = new Float64Array(bins);
  const im = new Float64Array(bins);
  const outRe = new Float64Array(bins);
  const outIm = new Float64Array(bins);
  const power = new Float64Array(bins);
  const peaks = new Int32Array(bins);
  const levels = new Float64Array(CHUNK);

  /**
   * Absolute sample counts. The ring starts with `LATENCY` samples of silence
   * already in it, which is the delay: input sample `i` sits at `LATENCY + i`
   * and output sample `q` is read from `q`, so the two are a frame apart
   * without any index ever being negative.
   */
  let written = LATENCY;
  let emitted = 0;
  /** The next frame start on the hop grid. Frames never move off it. */
  let nextFrame = 0;

  const glideSamples = Math.max(1, Math.round(GLIDE_SECONDS * sampleRate));

  let asked = clampSemitones(options.semitones ?? 0);
  let glideFrom = asked;
  let glideTo = asked;
  let mixFrom = asked === 0 ? 0 : 1;
  let mixTo = mixFrom;
  /** How far through the glide, in samples, held at the end when there is none. */
  let rampPos = glideSamples;
  /** Samples of overlap the vocoder is still filling before it is mixed in. */
  let warmup = 0;
  /** Whether frames are being rebuilt at all, or the bypass has it alone. */
  let vocoding = asked !== 0;
  /** Whether the accumulators have a frame behind them to advance from. */
  let primed = false;

  const progress = (): number => (rampPos >= glideSamples ? 1 : rampPos / glideSamples);

  const semitonesNow = (): number => glideFrom + (glideTo - glideFrom) * progress();

  const mixNow = (): number => mixFrom + (mixTo - mixFrom) * progress();

  /** The phase a peak carries on from, or null for one that has just appeared. */
  function carried(was: Uint8Array, kept: Float64Array, bin: number): number | null {
    if (was[bin] === 1) {
      return kept[bin] ?? null;
    }
    // A partial drifting between two bins is the same partial, so a peak one
    // bin either side of last frame's is carried on rather than restarted.
    if (bin > 0 && was[bin - 1] === 1) {
      return kept[bin - 1] ?? null;
    }
    if (bin + 1 < was.length && was[bin + 1] === 1) {
      return kept[bin + 1] ?? null;
    }
    return null;
  }

  /** One frame, every channel, from the hop grid position `start`. */
  function render(start: number): void {
    const ratio = pitchRatio(semitonesNow());
    /** Radians one bin advances in a hop. */
    const perHop = (TWO_PI * HOP) / FRAME;
    /** Bins a radian of phase deviation is worth. */
    const perRadian = FRAME / (TWO_PI * HOP);

    for (let channel = 0; channel < channels; channel += 1) {
      const dry = dryRings[channel];
      const wet = wetRings[channel];
      const wasRe = lastRe[channel];
      const wasIm = lastIm[channel];
      const kept = phases[channel];
      const was = peaked[channel];
      if (
        dry === undefined ||
        wet === undefined ||
        wasRe === undefined ||
        wasIm === undefined ||
        kept === undefined ||
        was === undefined
      ) {
        continue;
      }

      for (let index = 0; index < FRAME; index += 1) {
        frame[index] = (dry[(start + index) & MASK] ?? 0) * (window[index] ?? 0);
      }
      transform.forward(frame, re, im);

      let loudest = 0;
      for (let bin = 0; bin < bins; bin += 1) {
        const real = re[bin] ?? 0;
        const imaginary = im[bin] ?? 0;
        const here = real * real + imaginary * imaginary;
        power[bin] = here;
        loudest = Math.max(loudest, here);
      }
      const floor = Math.max(POWER_FLOOR, loudest * RELATIVE_FLOOR);

      // Peaks, in order, with the ends allowed to be one: a signal that is all
      // direct current has its only peak at bin zero. Strictly below on the
      // way up and loosely above on the way down, so that a plateau is one
      // peak at its left edge rather than two or none.
      let count = 0;
      for (let bin = 0; bin < bins; bin += 1) {
        const here = power[bin] ?? 0;
        if (here <= floor) {
          continue;
        }
        let highest = true;
        for (let away = 1; away <= PEAK_SPREAD && highest; away += 1) {
          const under = bin - away >= 0 ? (power[bin - away] ?? 0) : -1;
          const over = bin + away < bins ? (power[bin + away] ?? 0) : -1;
          highest = here > under && here >= over;
        }
        if (highest) {
          peaks[count] = bin;
          count += 1;
        }
      }

      outRe.fill(0);
      outIm.fill(0);

      for (let index = 0; index < count; index += 1) {
        const peak = peaks[index] ?? 0;
        const peakRe = re[peak] ?? 0;
        const peakIm = im[peak] ?? 0;
        const measured = Math.atan2(peakIm, peakRe);
        const carriedFrom = primed ? carried(was, kept, peak) : null;

        let target: number;
        if (carriedFrom === null) {
          // A partial that was not there last frame has no phase to continue,
          // and its own is the least surprising place to start it.
          target = measured;
        } else {
          // How far this bin's phase actually moved since the last frame, as
          // the argument of the ratio of the two complex values — one atan2
          // for the peak instead of one for every bin.
          const beforeRe = wasRe[peak] ?? 0;
          const beforeIm = wasIm[peak] ?? 0;
          const moved = Math.atan2(
            peakIm * beforeRe - peakRe * beforeIm,
            peakRe * beforeRe + peakIm * beforeIm,
          );
          const deviation = principal(moved - perHop * peak);
          // Where the partial really is, to a fraction of a bin. This, times
          // the ratio, is the frequency the output comes out at: the
          // accumulator is the only thing that decides that, which is why the
          // bin the magnitude lands in can be approximate and the pitch is
          // still exact.
          const trueBin = peak + deviation * perRadian;
          target = carriedFrom + ratio * trueBin * perHop;
        }
        kept[peak] = target;

        // Identity phase locking: every bin in this peak's region keeps the
        // phase it has relative to the peak in this frame, so the whole region
        // is one rotation of the analysed values.
        const turnRe = Math.cos(target - measured);
        const turnIm = Math.sin(target - measured);
        const low = index === 0 ? 0 : (((peaks[index - 1] ?? 0) + peak) >> 1) + 1;
        const high = index === count - 1 ? bins - 1 : ((peak + (peaks[index + 1] ?? 0)) >> 1);

        for (let bin = low; bin <= high; bin += 1) {
          const landing = bin * ratio;
          const lower = Math.floor(landing);
          if (lower < 0 || lower >= bins) {
            continue;
          }
          const part = landing - lower;
          const binRe = re[bin] ?? 0;
          const binIm = im[bin] ?? 0;
          const turnedRe = binRe * turnRe - binIm * turnIm;
          const turnedIm = binRe * turnIm + binIm * turnRe;
          // Spread across the two nearest bins rather than rounded into one.
          // Rounding leaves the magnitude up to half a bin from the frequency
          // the phase is advancing at, and that disagreement is heard as a
          // warble at the hop rate.
          outRe[lower] = (outRe[lower] ?? 0) + turnedRe * (1 - part);
          outIm[lower] = (outIm[lower] ?? 0) + turnedIm * (1 - part);
          if (part > 0 && lower + 1 < bins) {
            outRe[lower + 1] = (outRe[lower + 1] ?? 0) + turnedRe * part;
            outIm[lower + 1] = (outIm[lower + 1] ?? 0) + turnedIm * part;
          }
        }
      }

      // Direct current and Nyquist have no imaginary part in a real signal,
      // and a real transform handed one would give a frame that is not real.
      outIm[0] = 0;
      outIm[bins - 1] = 0;
      transform.inverse(outRe, outIm, frame);

      for (let index = 0; index < FRAME; index += 1) {
        const at = (start + index) & MASK;
        wet[at] = (wet[at] ?? 0) + (frame[index] ?? 0) * (window[index] ?? 0) * norm;
      }

      wasRe.set(re);
      wasIm.set(im);
      was.fill(0);
      for (let index = 0; index < count; index += 1) {
        was[peaks[index] ?? 0] = 1;
      }
    }

    primed = true;
  }

  /**
   * Starts the vocoder from nothing, holding it out of the mix until its
   * overlap is full.
   *
   * A frame plus a hop, because the first output sample every covering frame
   * has reached is a frame past the next frame start, and the next frame start
   * can be up to a hop ahead of where the output is being read. Until then the
   * frames add up to less than the signal, and mixing that in would be a dip.
   */
  function wake(): void {
    for (const ring of wetRings) {
      // Whatever the last frames before it went idle left beyond the read
      // position would otherwise be added to by the frames about to come.
      ring.fill(0);
    }
    primed = false;
    warmup = FRAME + HOP;
    vocoding = true;
  }

  return {
    channels,
    sampleRate,
    latencySamples: LATENCY,

    get semitones() {
      return asked;
    },

    setSemitones(semitones) {
      const next = clampSemitones(semitones);
      if (next === asked) {
        return;
      }
      // From wherever the last change had got to, so a key pressed twice in
      // quick succession is one slide rather than a jump back to the start.
      glideFrom = semitonesNow();
      mixFrom = mixNow();
      asked = next;
      glideTo = next;
      mixTo = next === 0 ? 0 : 1;
      rampPos = 0;
      if (!vocoding) {
        wake();
      }
    },

    process(input, output, frames) {
      const count = frames ?? output[0]?.length ?? 0;
      let done = 0;
      while (done < count) {
        const take = Math.min(CHUNK, count - done);

        for (let channel = 0; channel < channels; channel += 1) {
          const ring = dryRings[channel];
          const source = input[channel];
          if (ring === undefined) {
            continue;
          }
          for (let index = 0; index < take; index += 1) {
            ring[(written + index) & MASK] = source?.[done + index] ?? 0;
          }
        }
        written += take;

        while (nextFrame + FRAME <= written) {
          if (vocoding) {
            render(nextFrame);
          }
          nextFrame += HOP;
        }

        // The crossfade moves per sample, so it is worked out once here rather
        // than per channel, where it would step at every channel boundary.
        for (let index = 0; index < take; index += 1) {
          levels[index] = mixNow();
          if (warmup > 0) {
            warmup -= 1;
          } else if (rampPos < glideSamples) {
            rampPos += 1;
          }
        }

        for (let channel = 0; channel < channels; channel += 1) {
          const dry = dryRings[channel];
          const wet = wetRings[channel];
          const target = output[channel];
          if (dry === undefined || wet === undefined || target === undefined) {
            continue;
          }
          for (let index = 0; index < take; index += 1) {
            const at = (emitted + index) & MASK;
            const delayed = dry[at] ?? 0;
            const level = levels[index] ?? 0;
            // Exactly the delayed input when nothing is being shifted, rather
            // than nearly it: the bypass has to be bit for bit, or toggling
            // transpose would be audible on its own.
            target[done + index] =
              level <= 0 ? delayed : delayed + ((wet[at] ?? 0) - delayed) * level;
            // Read once and cleared, because the frames that will cover the
            // next laps add into it.
            wet[at] = 0;
          }
        }
        emitted += take;
        done += take;
      }

      if (vocoding && mixTo === 0 && rampPos >= glideSamples && warmup === 0) {
        // Faded out and asked for nothing: the bypass has it on its own again.
        vocoding = false;
      }
    },

    reset() {
      written = LATENCY;
      emitted = 0;
      nextFrame = 0;
      for (const ring of dryRings) {
        ring.fill(0);
      }
      for (const ring of wetRings) {
        ring.fill(0);
      }
      for (const kept of phases) {
        kept.fill(0);
      }
      for (const ring of lastRe) {
        ring.fill(0);
      }
      for (const ring of lastIm) {
        ring.fill(0);
      }
      for (const was of peaked) {
        was.fill(0);
      }
      primed = false;
      warmup = 0;
      // The key is a choice the person made and a reset is not them changing
      // their mind, so it survives — and arrives at once, because there is no
      // audio left for a glide to be smooth across.
      glideFrom = asked;
      glideTo = asked;
      mixFrom = asked === 0 ? 0 : 1;
      mixTo = mixFrom;
      rampPos = glideSamples;
      vocoding = asked !== 0;
    },
  };
}
