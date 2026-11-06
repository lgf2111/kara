/**
 * Pitch detection and the note arithmetic around it.
 *
 * One detector serves both halves of practice: the offline pass reads a note
 * timeline from the separated vocal stem, and the live pass reads the person's
 * microphone. They must agree about what a note is, so they share this file
 * and the same range and clarity rules. Nothing here touches the DOM, Chrome
 * or an audio graph, which is what makes a synthetic sine wave a real test.
 *
 * The detector is YIN in the form the paper gives it: an autocorrelation-like
 * difference function, normalised by its own cumulative mean, with the first
 * clear dip taken as the period. That first-dip rule is what stops a strong
 * second harmonic from being reported as an octave above the singer. A pure
 * sine is the easy case; the thresholds are set for a voice over a backing
 * track rather than for the easy case alone.
 */

/** The bottom of the range a singer is expected to reach, in Hz. */
export const PITCH_MIN_HZ = 70;

/** The top of it. Above this is whistle territory, not a guide melody. */
export const PITCH_MAX_HZ = 1000;

/** Below this normalised difference a frame counts as pitched at all. */
export const PITCH_CLARITY = 0.75;

/** Quieter than this is silence rather than a quiet note. */
export const PITCH_MIN_LEVEL = 0.004;

/** One reading of a frame: a frequency, its MIDI twin, and how sure it is. */
export interface PitchReading {
  /** The detected frequency, or null for silence, noise or an out-of-range read. */
  readonly hz: number | null;
  /** Fractional MIDI, so a singer 30 cents sharp lands between two keys. */
  readonly midi: number | null;
  /** One minus the normalised difference at the chosen period. */
  readonly clarity: number;
  /** Root-mean-square level of the frame, nought to one for normal audio. */
  readonly level: number;
}

/** A reading with the song time it was taken at. */
export interface PitchFrame extends PitchReading {
  /** Seconds from the start of the song. */
  readonly at: number;
}

export interface PitchOptions {
  readonly minHz?: number;
  readonly maxHz?: number;
  /** The first-dip threshold. Smaller is stricter. */
  readonly threshold?: number;
  /** Below this clarity the reading is reported as unpitched. */
  readonly minClarity?: number;
  readonly minLevel?: number;
}

const NO_PITCH: PitchReading = { hz: null, midi: null, clarity: 0, level: 0 };

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteBetween(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A frequency as fractional MIDI, where 69 is A4 at 440 Hz. */
export function hzToMidi(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) {
    return Number.NaN;
  }
  return 69 + 12 * Math.log2(hz / 440);
}

/** The frequency of a fractional MIDI note. */
export function midiToHz(midi: number): number {
  if (!Number.isFinite(midi)) {
    return Number.NaN;
  }
  return 440 * 2 ** ((midi - 69) / 12);
}

/** How far one frequency is from another, in cents. Positive is sharp. */
export function centsBetween(hz: number, targetHz: number): number {
  if (!Number.isFinite(hz) || !Number.isFinite(targetHz) || hz <= 0 || targetHz <= 0) {
    return Number.NaN;
  }
  return 1200 * Math.log2(hz / targetHz);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** A MIDI note's name and octave, using sharps: 69 is A4. */
export function noteName(midi: number): string {
  if (!Number.isFinite(midi)) {
    return '?';
  }
  const whole = Math.round(midi);
  const name = NOTE_NAMES[((whole % 12) + 12) % 12] ?? 'C';
  return `${name}${String(Math.floor(whole / 12) - 1)}`;
}

/**
 * The pitch of one frame, or an unpitched reading with its level.
 *
 * The frame is copied before the mean is removed, so the caller's buffer can
 * be reused by an analyser or a worker without this reading changing under it.
 */
export function detectPitch(
  frame: Float32Array,
  sampleRate: number,
  options: PitchOptions = {},
): PitchReading {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || frame.length < 32) {
    return NO_PITCH;
  }

  let energy = 0;
  for (const sample of frame) {
    energy += sample * sample;
  }
  const level = Math.sqrt(energy / frame.length);
  const minLevel = positive(options.minLevel, PITCH_MIN_LEVEL);
  if (!Number.isFinite(level) || level < minLevel) {
    return { ...NO_PITCH, level: Number.isFinite(level) ? level : 0 };
  }

  let mean = 0;
  for (const sample of frame) {
    mean += sample;
  }
  mean /= frame.length;

  // Centred samples in a private buffer: the difference function is very
  // sensitive to a DC offset, and the caller's array is not ours to change.
  const centred = new Float32Array(frame.length);
  for (let index = 0; index < frame.length; index += 1) {
    centred[index] = (frame[index] ?? 0) - mean;
  }

  const minHz = positive(options.minHz, PITCH_MIN_HZ);
  const maxHz = Math.max(minHz + 1, positive(options.maxHz, PITCH_MAX_HZ));
  const tauMin = Math.max(2, Math.ceil(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(sampleRate / minHz), Math.floor(frame.length / 2));
  if (tauMax <= tauMin) {
    return { ...NO_PITCH, level };
  }

  // d(tau) is the squared difference between the frame and itself shifted by
  // tau. The window shrinks with tau, exactly as YIN defines it.
  const difference = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau += 1) {
    let sum = 0;
    const end = frame.length - tau;
    for (let index = 0; index < end; index += 1) {
      const delta = (centred[index] ?? 0) - (centred[index + tau] ?? 0);
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  // The cumulative mean normalisation: this is what makes the threshold a
  // property of the shape rather than of how loud the frame happened to be.
  const normalised = new Float32Array(tauMax + 1);
  normalised[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    running += difference[tau] ?? 0;
    const value = difference[tau] ?? 0;
    normalised[tau] = running === 0 ? 1 : (value * tau) / running;
  }

  const threshold = positive(options.threshold, 0.2);
  let bestTau = -1;
  for (let tau = tauMin; tau < tauMax; tau += 1) {
    const value = normalised[tau] ?? 1;
    const next = normalised[tau + 1] ?? 1;
    if (value < threshold && value <= next) {
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let tau = tauMin; tau <= tauMax; tau += 1) {
      const value = normalised[tau] ?? Number.POSITIVE_INFINITY;
      if (value < best) {
        best = value;
        bestTau = tau;
      }
    }
  }

  const bestValue = normalised[bestTau] ?? 1;
  const before = normalised[bestTau - 1] ?? bestValue;
  const after = normalised[bestTau + 1] ?? bestValue;
  const curve = before - 2 * bestValue + after;
  const shift = curve === 0 ? 0 : finiteBetween((before - after) / (2 * curve), -0.5, 0.5);
  const period = bestTau + shift;
  const clarity = finiteBetween(1 - bestValue, 0, 1);
  const minClarity = positive(options.minClarity, 0.5);
  const hz = period > 0 ? sampleRate / period : Number.NaN;
  if (
    !Number.isFinite(hz) ||
    hz < minHz ||
    hz > maxHz ||
    clarity < minClarity
  ) {
    return { hz: null, midi: null, clarity, level };
  }

  const midi = hzToMidi(hz);
  return { hz, midi: Number.isFinite(midi) ? midi : null, clarity, level };
}

/**
 * The input rate reduced to the analysis rate, by averaging each output
 * sample's span.
 *
 * The average is a crude low-pass and an adequate one: the detector only
 * looks below a kilohertz, so the top of the original band is noise to it.
 * It is much cheaper than a windowed resampler and keeps a four-minute stem
 * to a minute or two of arithmetic rather than an afternoon.
 */
export function downsampleForPitch(
  samples: Float32Array,
  inputRate: number,
  outputRate = 16_000,
): Float32Array {
  if (
    samples.length === 0 ||
    !Number.isFinite(inputRate) ||
    !Number.isFinite(outputRate) ||
    inputRate <= 0 ||
    outputRate <= 0
  ) {
    return new Float32Array(0);
  }
  if (inputRate <= outputRate) {
    return samples.slice();
  }
  const ratio = inputRate / outputRate;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor((index + 1) * ratio)),
    );
    let sum = 0;
    for (let at = start; at < end; at += 1) {
      sum += samples[at] ?? 0;
    }
    output[index] = sum / (end - start);
  }
  return output;
}
