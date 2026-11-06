import {
  PITCH_CLARITY,
  PITCH_MAX_HZ,
  PITCH_MIN_HZ,
  detectPitch,
  downsampleForPitch,
  noteName,
} from './pitch.ts';

/**
 * What the song is, from the separated stems: a key, a tempo and the notes a
 * singer actually has to reach.
 *
 * This is the pure half of the analysis card. It reads three monophonic
 * signals the separation already produced — the harmonic stems for a key, the
 * drums for a pulse, and the vocal for a range — and never touches an
 * `AudioContext`, a worker or the DOM. The worker is the only caller that
 * matters, and synthetic chords, pulses and sweeps are the tests.
 *
 * **The key is a chroma correlation, not a guess from one chord.** A spectrum
 * is folded into twelve pitch classes, and those twelve numbers are compared
 * with the Krumhansl–Kessler major and minor profiles at all twelve tonics.
 * The winner only reaches the panel when it is both a good fit and clearly
 * ahead of the runner-up; a song that is two keys at once shows `?` instead of
 * one of them.
 *
 * **The tempo is an autocorrelation of onset strength.** A drum stem is turned
 * into a spectral-flux envelope, and the lag where that envelope repeats is
 * the beat. A gentle prior keeps the octave ambiguity on the side of a tempo a
 * person would tap, and a weak peak is no tempo at all.
 *
 * **The range is percentiles, not extremes.** One shouted high note is not the
 * top of the song. The fifth and ninety-fifth percentiles of the confident
 * frames are what a singer is asked to reach.
 */

/** The rate these analyses run at. A guide melody needs no more. */
export const SONG_ANALYSIS_RATE = 16_000;

/** A key only reaches the panel above this confidence. */
export const KEY_MIN_CONFIDENCE = 0.35;

/** A tempo only reaches the panel above this confidence. */
export const BPM_MIN_CONFIDENCE = 0.3;

/** The chroma frame and hop, in samples at {@link SONG_ANALYSIS_RATE}. */
const CHROMA_FRAME = 8192;
const CHROMA_HOP = 4096;

/** The lowest and highest partial a chroma trusts. */
const CHROMA_MIN_HZ = 65;
const CHROMA_MAX_HZ = 2000;

/** Below this RMS a frame is silence rather than a quiet chord. */
const CHROMA_MIN_LEVEL = 0.002;

/** The onset frame and hop: a sixteenth of a second, so a beat lands somewhere. */
const ONSET_FRAME = 1024;
const ONSET_HOP = 256;

/** The vocal range frame and hop, the same shape practice analyses with. */
const RANGE_FRAME = 1024;
const RANGE_HOP = 512;

/** How many confident vocal frames a range needs before it is shown. */
const RANGE_MIN_FRAMES = 12;

/** The Krumhansl–Kessler key profiles, in C. */
const MAJOR_PROFILE: readonly number[] = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: readonly number[] = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/** The sharp names, matching `noteName` in the pitch module. */
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface SongKey {
  /** The tonic as a pitch class, 0 for C. */
  readonly tonic: number;
  readonly mode: 'major' | 'minor';
  /** Nought to one: how far ahead of the runner-up it is. */
  readonly confidence: number;
}

export interface SongRange {
  /** The low comfortable note as a MIDI number. */
  readonly lowMidi: number;
  /** And the high one. */
  readonly highMidi: number;
  /** Nought to one: how much confident material the range rests on. */
  readonly confidence: number;
  /** Confident frames the percentiles were taken from. */
  readonly frames: number;
}

export interface SongFacts {
  /** Null when the chroma did not name a key clearly. */
  readonly key: SongKey | null;
  /** The beat, or null when the onset envelope had no clear period. */
  readonly bpm: number | null;
  /** Nought to one, kept even when the bpm was too weak to show. */
  readonly bpmConfidence: number;
  /** The comfortable vocal range, or null with too little singing. */
  readonly range: SongRange | null;
}

export type SongAnalysisState = 'analyzing' | 'ready' | 'error';

/** The one-shot analysis state the panel reads. */
export interface SongAnalysis {
  readonly state: SongAnalysisState;
  /** Nought to one while analysing, null when there is no bar. */
  readonly progress: number | null;
  readonly facts: SongFacts | null;
  readonly detail: string | null;
}

export interface ChromaOptions {
  readonly frameSize?: number;
  readonly hopSize?: number;
  readonly minHz?: number;
  readonly maxHz?: number;
  readonly minLevel?: number;
}

export interface TempoOptions {
  readonly minBpm?: number;
  readonly maxBpm?: number;
}

export interface OnsetEnvelope {
  readonly envelope: Float32Array;
  readonly hopSeconds: number;
}

export interface RangeOptions {
  readonly lowFraction?: number;
  readonly highFraction?: number;
  readonly minFrames?: number;
}

export interface SongAnalysisOptions {
  readonly onProgress?: (fraction: number) => void;
  readonly keyMinConfidence?: number;
  readonly bpmMinConfidence?: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An iterative radix-2 FFT, in place. The length must be a power of two. */
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  let reversed = 0;
  for (let index = 1; index < n; index += 1) {
    let bit = n >> 1;
    while ((reversed & bit) !== 0) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      const swapReal = real[index] ?? 0;
      const swapImag = imag[index] ?? 0;
      real[index] = real[reversed] ?? 0;
      imag[index] = imag[reversed] ?? 0;
      real[reversed] = swapReal;
      imag[reversed] = swapImag;
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    const half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let turnReal = 1;
      let turnImag = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = (real[odd] ?? 0) * turnReal - (imag[odd] ?? 0) * turnImag;
        const oddImag = (real[odd] ?? 0) * turnImag + (imag[odd] ?? 0) * turnReal;
        real[odd] = (real[even] ?? 0) - oddReal;
        imag[odd] = (imag[even] ?? 0) - oddImag;
        real[even] = (real[even] ?? 0) + oddReal;
        imag[even] = (imag[even] ?? 0) + oddImag;
        const nextReal = turnReal * stepReal - turnImag * stepImag;
        turnImag = turnReal * stepImag + turnImag * stepReal;
        turnReal = nextReal;
      }
    }
  }
}

/** A Hann window, which is what stops a frame's edges becoming partials. */
function hann(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, size - 1));
  }
  return window;
}

/** The magnitude at one bin, with its neighbours, for a peak test. */
function binMagnitude(real: Float64Array, imag: Float64Array, bin: number): number {
  return Math.hypot(real[bin] ?? 0, imag[bin] ?? 0);
}

/**
 * A spectrum folded into twelve pitch classes.
 *
 * Only local spectral peaks contribute: a broadband hiss would otherwise add
 * the same small amount to every key and wash the answer out. A mild `1 / f`
 * weight keeps a loud bass fundamental from outvoting the harmony above it.
 */
export function chromaFromSamples(
  samples: Float32Array,
  sampleRate: number,
  options: ChromaOptions = {},
): Float32Array {
  const chroma = new Float32Array(12);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length < 256) {
    return chroma;
  }
  const frameSize = Math.max(256, Math.round(positive(options.frameSize, CHROMA_FRAME)));
  const hopSize = Math.max(1, Math.min(frameSize, Math.round(positive(options.hopSize, CHROMA_HOP))));
  const minHz = positive(options.minHz, CHROMA_MIN_HZ);
  const maxHz = Math.max(minHz + 1, positive(options.maxHz, CHROMA_MAX_HZ));
  const minLevel = positive(options.minLevel, CHROMA_MIN_LEVEL);
  const window = hann(frameSize);
  const real = new Float64Array(frameSize);
  const imag = new Float64Array(frameSize);
  const perBin = sampleRate / frameSize;
  const firstBin = Math.max(1, Math.ceil(minHz / perBin));
  const lastBin = Math.min(frameSize / 2 - 2, Math.floor(maxHz / perBin));

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    let energy = 0;
    for (let index = 0; index < frameSize; index += 1) {
      const sample = samples[start + index] ?? 0;
      energy += sample * sample;
    }
    if (Math.sqrt(energy / frameSize) < minLevel) {
      continue;
    }

    for (let index = 0; index < frameSize; index += 1) {
      real[index] = (samples[start + index] ?? 0) * (window[index] ?? 0);
      imag[index] = 0;
    }
    fft(real, imag);

    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const magnitude = binMagnitude(real, imag, bin);
      if (
        magnitude <= binMagnitude(real, imag, bin - 1) ||
        magnitude < binMagnitude(real, imag, bin + 1)
      ) {
        continue;
      }
      const hz = bin * perBin;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      // Power, weighted down as the partials climb: a fundamental is a
      // statement about the key, a fifth harmonic is an overtone.
      chroma[pitchClass] =
        (chroma[pitchClass] ?? 0) + (magnitude * magnitude) / Math.sqrt(hz / 220);
    }
  }

  let total = 0;
  for (const value of chroma) {
    total += value;
  }
  if (total > 0) {
    for (let index = 0; index < chroma.length; index += 1) {
      chroma[index] = (chroma[index] ?? 0) / total;
    }
  }
  return chroma;
}

function correlation(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  if (length < 2) {
    return 0;
  }
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < length; index += 1) {
    leftMean += left[index] ?? 0;
    rightMean += right[index] ?? 0;
  }
  leftMean /= length;
  rightMean /= length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = (left[index] ?? 0) - leftMean;
    const rightValue = (right[index] ?? 0) - rightMean;
    covariance += leftValue * rightValue;
    leftVariance += leftValue * leftValue;
    rightVariance += rightValue * rightValue;
  }
  const scale = Math.sqrt(leftVariance * rightVariance);
  return scale === 0 ? 0 : covariance / scale;
}

function profileScore(chroma: ArrayLike<number>, tonic: number, profile: readonly number[]): number {
  const rotated = new Float64Array(12);
  for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
    rotated[pitchClass] = profile[((pitchClass - tonic) % 12 + 12) % 12] ?? 0;
  }
  return correlation(chroma, rotated);
}

/**
 * The key a chroma most looks like, with the margin over the next key.
 *
 * The relative major is another key and not a tie-break: a C major profile
 * and an A minor profile are usually the two strongest answers, and the
 * margin between them is exactly the thing a low-confidence report is made
 * of.
 */
export function keyFromChroma(chroma: ArrayLike<number>): SongKey | null {
  if (chroma.length < 12) {
    return null;
  }
  let total = 0;
  for (let index = 0; index < 12; index += 1) {
    total += Math.max(0, chroma[index] ?? 0);
  }
  if (total <= 0) {
    return null;
  }

  let best: { readonly tonic: number; readonly mode: 'major' | 'minor'; readonly score: number } | null =
    null;
  let second = Number.NEGATIVE_INFINITY;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const score = profileScore(chroma, tonic, profile);
      if (!Number.isFinite(score)) {
        continue;
      }
      if (best === null || score > best.score) {
        second = best?.score ?? Number.NEGATIVE_INFINITY;
        best = { tonic, mode, score };
      } else if (score > second) {
        second = score;
      }
    }
  }
  if (best === null) {
    return null;
  }
  const margin = Number.isFinite(second) ? best.score - second : best.score;
  const strength = clamp((best.score - 0.15) / 0.55, 0, 1);
  const confidence = clamp(margin / 0.18, 0, 1) * strength;
  return { tonic: best.tonic, mode: best.mode, confidence };
}

/**
 * The onset strength of every frame, as spectral flux over its own spectrum.
 *
 * Normalising by the frame's own magnitude is what lets a quiet brush stroke
 * register as an onset: tempo is about when something changes, not how loud it
 * was. The first frame has no predecessor and is silence by definition.
 */
export function onsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
  options: { readonly frameSize?: number; readonly hopSize?: number } = {},
): OnsetEnvelope {
  const empty = new Float32Array(0);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length < 256) {
    return { envelope: empty, hopSeconds: 0 };
  }
  const frameSize = Math.max(256, Math.round(positive(options.frameSize, ONSET_FRAME)));
  const hopSize = Math.max(1, Math.min(frameSize, Math.round(positive(options.hopSize, ONSET_HOP))));
  const hopSeconds = hopSize / sampleRate;
  if (samples.length < frameSize * 2) {
    return { envelope: empty, hopSeconds };
  }

  const window = hann(frameSize);
  const real = new Float64Array(frameSize);
  const imag = new Float64Array(frameSize);
  const previous = new Float64Array(frameSize / 2);
  const points: number[] = [];

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    for (let index = 0; index < frameSize; index += 1) {
      real[index] = (samples[start + index] ?? 0) * (window[index] ?? 0);
      imag[index] = 0;
    }
    fft(real, imag);

    let flux = 0;
    let power = 0;
    for (let bin = 1; bin < frameSize / 2; bin += 1) {
      const magnitude = binMagnitude(real, imag, bin);
      const change = magnitude - (previous[bin] ?? 0);
      if (change > 0) {
        flux += change;
      }
      previous[bin] = magnitude;
      power += magnitude * magnitude;
    }
    const scale = Math.sqrt(power);
    points.push(scale > 0 ? flux / scale : 0);
  }

  // The first frame is an onset against silence; the song did not start with
  // a beat, and leaving it in would put a spurious pulse at time nought.
  if (points.length > 0) {
    points[0] = 0;
  }
  return { envelope: Float32Array.from(points), hopSeconds };
}

interface TempoCandidate {
  readonly bpm: number;
  readonly strength: number;
  readonly score: number;
}

/**
 * The beat among the lags that repeat, or null when nothing repeats.
 *
 * The autocorrelation is normalised by its own zero lag and evaluated at
 * every local maximum in the allowed range. The strength includes the next two
 * multiples of the lag, so a beat and its own half-tempo both look strong; a
 * gentle prior for a tempo near 110 BPM chooses the one a listener would tap
 * instead of the mathematically equal answer an octave below.
 */
export function estimateTempo(
  envelope: ArrayLike<number>,
  hopSeconds: number,
  options: TempoOptions = {},
): { readonly bpm: number; readonly confidence: number } | null {
  if (!Number.isFinite(hopSeconds) || hopSeconds <= 0 || envelope.length < 16) {
    return null;
  }
  const minBpm = positive(options.minBpm, 50);
  const maxBpm = Math.max(minBpm + 1, positive(options.maxBpm, 200));
  const length = envelope.length;
  let mean = 0;
  for (let index = 0; index < length; index += 1) {
    const value = envelope[index] ?? 0;
    mean += Number.isFinite(value) ? value : 0;
  }
  mean /= length;
  const values = new Float64Array(length);
  let energy = 0;
  for (let index = 0; index < length; index += 1) {
    const value = (envelope[index] ?? 0) - mean;
    values[index] = value;
    energy += value * value;
  }
  if (energy <= 1e-12) {
    return null;
  }
  const zero = energy / length;
  const maxLag = Math.min(length - 1, Math.ceil(60 / (minBpm * hopSeconds)) + 3);
  const correlations = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index + lag < length; index += 1) {
      sum += (values[index] ?? 0) * (values[index + lag] ?? 0);
    }
    correlations[lag] = sum / (Math.max(1, length - lag) * zero);
  }

  const lagMin = Math.max(2, Math.floor(60 / (maxBpm * hopSeconds)));
  const lagMax = Math.min(maxLag, Math.ceil(60 / (minBpm * hopSeconds)));
  const candidates: TempoCandidate[] = [];
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    const current = correlations[lag] ?? 0;
    if (current <= 0) {
      continue;
    }
    if (current < (correlations[lag - 1] ?? 0) || current < (correlations[lag + 1] ?? 0)) {
      continue;
    }
    const before = correlations[lag - 1] ?? current;
    const after = correlations[lag + 1] ?? current;
    const curve = before - 2 * current + after;
    const shift = curve === 0 ? 0 : clamp((before - after) / (2 * curve), -0.5, 0.5);
    const refined = lag + shift;
    const bpm = 60 / (refined * hopSeconds);
    if (!Number.isFinite(bpm) || bpm < minBpm || bpm > maxBpm) {
      continue;
    }
    const double = correlations[Math.min(maxLag, Math.round(lag * 2))] ?? 0;
    const triple = correlations[Math.min(maxLag, Math.round(lag * 3))] ?? 0;
    const strength = current + 0.5 * double + 0.25 * triple;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.5) ** 2);
    candidates.push({ bpm, strength, score: strength * prior });
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0] as TempoCandidate;
  const confidence = clamp((best.strength - 0.25) / 0.75, 0, 1);
  if (confidence <= 0.05) {
    return null;
  }
  return { bpm: best.bpm, confidence };
}

/** The beat in a signal, through the onset envelope. */
export function detectTempo(
  samples: Float32Array,
  sampleRate: number,
  options: TempoOptions & { readonly frameSize?: number; readonly hopSize?: number } = {},
): { readonly bpm: number; readonly confidence: number } | null {
  const onset = onsetEnvelope(samples, sampleRate, options);
  return estimateTempo(onset.envelope, onset.hopSeconds, options);
}

/**
 * A percentile of a sorted list, linearly interpolated between neighbours.
 *
 * Sorted input is the contract: this is called for each end of a range after
 * one sort, not for a list in arrival order.
 */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

/**
 * The comfortable low and high note from a pile of confident MIDI frames.
 *
 * The fifth and ninety-fifth percentiles ignore the one breathy scream and the
 * one creaky ending while still being the song's own notes. Frames are the
 * unit rather than seconds because every frame is the same hop.
 */
export function rangePercentiles(midis: readonly number[], options: RangeOptions = {}): SongRange | null {
  const values = midis.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  const minFrames = Math.max(1, Math.round(positive(options.minFrames, RANGE_MIN_FRAMES)));
  if (values.length < minFrames) {
    return null;
  }
  const lowFraction = clamp(options.lowFraction ?? 0.05, 0, 0.5);
  const highFraction = clamp(options.highFraction ?? 0.95, 0.5, 1);
  const low = percentile(values, lowFraction);
  const high = percentile(values, highFraction);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) {
    return null;
  }
  return {
    lowMidi: Math.round(clamp(low, 0, 127)),
    highMidi: Math.round(clamp(high, 0, 127)),
    confidence: clamp(values.length / 150, 0.1, 1),
    frames: values.length,
  };
}

/**
 * The range a vocal stem actually sings, through the same detector practice
 * uses. The stem arrives at the analysis rate; a caller with an original-rate
 * copy is downsampled here rather than at the panel.
 */
export function analyseVocalRange(
  samples: Float32Array,
  sampleRate: number,
  options: RangeOptions & { readonly analysisRate?: number } = {},
): SongRange | null {
  const analysisRate = positive(options.analysisRate, SONG_ANALYSIS_RATE);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length < RANGE_FRAME) {
    return null;
  }
  const resampled =
    Math.abs(sampleRate - analysisRate) < 1e-9
      ? samples
      : downsampleForPitch(samples, sampleRate, analysisRate);
  if (resampled.length < RANGE_FRAME) {
    return null;
  }

  const frame = new Float32Array(RANGE_FRAME);
  const midis: number[] = [];
  for (let start = 0; start + RANGE_FRAME <= resampled.length; start += RANGE_HOP) {
    frame.fill(0);
    frame.set(resampled.subarray(start, start + RANGE_FRAME));
    const reading = detectPitch(frame, analysisRate, {
      minHz: PITCH_MIN_HZ,
      maxHz: PITCH_MAX_HZ,
      minClarity: PITCH_CLARITY,
    });
    if (reading.midi !== null && reading.clarity >= PITCH_CLARITY) {
      midis.push(reading.midi);
    }
  }
  return rangePercentiles(midis, options);
}

/** The key as a person reads it: `G major`, `E minor`. */
export function keyName(key: SongKey): string {
  const pitchClass = ((Math.round(key.tonic) % 12) + 12) % 12;
  return `${KEY_NAMES[pitchClass] ?? 'C'} ${key.mode}`;
}

/** The range as a person reads it: `C3–E5`. */
export function rangeLabel(range: SongRange): string {
  return `${noteName(range.lowMidi)}–${noteName(range.highMidi)}`;
}

interface SongStems {
  /** Bass and other (and the vocal), mixed mono, at the analysis rate. */
  readonly harmonic: Float32Array;
  /** The drum stem alone, for its onsets. */
  readonly percussive: Float32Array;
  /** The vocal stem alone, for its range. */
  readonly vocals: Float32Array;
}

/**
 * The whole analysis, in one pure call. The worker supplies the three stems
 * and receives the three things the card shows; nothing here knows where they
 * came from.
 */
export function analyseSong(
  stems: SongStems,
  sampleRate: number,
  options: SongAnalysisOptions = {},
): SongFacts {
  const progress = (fraction: number): void => {
    options.onProgress?.(clamp(fraction, 0, 1));
  };

  progress(0.05);
  const found = keyFromChroma(chromaFromSamples(stems.harmonic, sampleRate));
  progress(0.45);

  let tempo = detectTempo(stems.percussive, sampleRate);
  if (tempo === null || tempo.confidence < BPM_MIN_CONFIDENCE) {
    const fromHarmony = detectTempo(stems.harmonic, sampleRate);
    if (fromHarmony !== null && (tempo === null || fromHarmony.confidence > tempo.confidence)) {
      tempo = fromHarmony;
    }
  }
  progress(0.8);

  const range = analyseVocalRange(stems.vocals, sampleRate);
  progress(1);

  const keyMin = options.keyMinConfidence ?? KEY_MIN_CONFIDENCE;
  const bpmMin = options.bpmMinConfidence ?? BPM_MIN_CONFIDENCE;
  const bpm =
    tempo !== null && tempo.confidence >= bpmMin
      ? Math.round(tempo.bpm * 10) / 10
      : null;
  return {
    key: found !== null && found.confidence >= keyMin ? found : null,
    bpm,
    bpmConfidence: tempo?.confidence ?? 0,
    range,
  };
}

/**
 * The facts out of a report or a cached entry, with every number bounded.
 *
 * A malformed field falls back to "not known" rather than to a guess. The
 * result itself is never null: a song with no clear key, tempo or range is a
 * real analysis result, and the card draws question marks for it.
 */
export function normaliseSongFacts(raw: unknown): SongFacts {
  const facts = recordOf(raw);

  const keyStored = recordOf(facts['key']);
  const tonic = numberOrNull(keyStored['tonic']);
  const keyConfidence = clamp(numberOrNull(keyStored['confidence']) ?? 0, 0, 1);
  const mode: 'major' | 'minor' | null =
    keyStored['mode'] === 'major' || keyStored['mode'] === 'minor' ? keyStored['mode'] : null;
  const key: SongKey | null =
    tonic === null || mode === null || keyConfidence < KEY_MIN_CONFIDENCE
      ? null
      : {
          tonic: clamp(Math.round(tonic), 0, 11),
          mode,
          confidence: keyConfidence,
        };

  const rawBpm = numberOrNull(facts['bpm']);
  const bpmConfidence = clamp(numberOrNull(facts['bpmConfidence']) ?? 0, 0, 1);
  const bpm =
    rawBpm !== null && rawBpm >= 20 && rawBpm <= 300 && bpmConfidence >= BPM_MIN_CONFIDENCE
      ? rawBpm
      : null;

  const rangeStored = recordOf(facts['range']);
  const low = numberOrNull(rangeStored['lowMidi']);
  const high = numberOrNull(rangeStored['highMidi']);
  const range =
    low === null || high === null || low < 0 || high > 127 || high < low
      ? null
      : {
          lowMidi: Math.round(low),
          highMidi: Math.round(high),
          confidence: clamp(numberOrNull(rangeStored['confidence']) ?? 0, 0, 1),
          frames: Math.max(0, Math.round(numberOrNull(rangeStored['frames']) ?? 0)),
        };

  return { key, bpm, bpmConfidence, range };
}

/**
 * An analysis report from the offscreen document, made safe for the page.
 *
 * Everything is bounded the way the panel draws it: a tonic is a pitch class,
 * a range is inside MIDI, and a malformed field falls back to "not known"
 * rather than to a guess.
 */
export function normaliseSongAnalysis(raw: unknown): SongAnalysis {
  const stored = recordOf(raw);
  const state =
    stored['state'] === 'ready' || stored['state'] === 'error' ? stored['state'] : 'analyzing';
  const progress = numberOrNull(stored['progress']);

  return {
    state,
    progress: progress === null ? null : clamp(progress, 0, 1),
    facts: state === 'ready' ? normaliseSongFacts(stored['facts']) : null,
    detail:
      typeof stored['detail'] === 'string' && stored['detail'] !== '' ? stored['detail'] : null,
  };
}
