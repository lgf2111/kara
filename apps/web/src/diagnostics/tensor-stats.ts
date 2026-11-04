/**
 * Shapes of a tensor, not its contents. Nothing here prints a value that could
 * be audio: counts, ranges and index positions only.
 */

/** Largest finite fp16 value. A peak at or past this is the overflow story. */
export const FP16_MAX = 65504;

/**
 * Half precision to double, for the fp16 halves of this model's chain. ONNX
 * Runtime hands those back as a Uint16Array unless the engine has a native
 * Float16Array, in which case {@link toFloat32} never reaches this.
 */
export function halfToFloat(half: number): number {
  const sign = (half & 0x8000) === 0 ? 1 : -1;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Whatever a tensor's `data` is, as float32. A Uint16Array means fp16 halves;
 * any other view is read element by element, which covers Float16Array where
 * the engine has one and BigInt64Array for shape tensors.
 */
export function toFloat32(data: unknown): Float32Array {
  if (data instanceof Float32Array) {
    return data;
  }
  if (data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      out[i] = halfToFloat(data[i] ?? 0);
    }
    return out;
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as unknown as { length: number; [index: number]: unknown };
    const out = new Float32Array(view.length);
    for (let i = 0; i < view.length; i += 1) {
      out[i] = Number(view[i]);
    }
    return out;
  }
  throw new Error('tensor data is not an array view');
}

export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface TensorStats {
  readonly count: number;
  readonly nan: number;
  readonly posInf: number;
  readonly negInf: number;
  readonly nonFinite: number;
  /** Over the finite values only; null when every value is non-finite. */
  readonly min: number | null;
  readonly max: number | null;
  readonly meanAbs: number | null;
  /** Largest finite magnitude, to compare against {@link FP16_MAX}. */
  readonly peak: number | null;
  /** The first few contiguous runs of non-finite elements. */
  readonly badSpans: readonly Span[];
}

export function tensorStats(values: Float32Array, maxSpans = 6): TensorStats {
  let nan = 0;
  let posInf = 0;
  let negInf = 0;
  let min = Infinity;
  let max = -Infinity;
  let absSum = 0;
  let finite = 0;
  const badSpans: Span[] = [];
  let runFrom = -1;
  let index = 0;

  for (const value of values) {
    const bad = !Number.isFinite(value);
    if (bad) {
      if (Number.isNaN(value)) {
        nan += 1;
      } else if (value > 0) {
        posInf += 1;
      } else {
        negInf += 1;
      }
      if (runFrom < 0) {
        runFrom = index;
      }
    } else {
      finite += 1;
      absSum += Math.abs(value);
      min = Math.min(min, value);
      max = Math.max(max, value);
      if (runFrom >= 0) {
        if (badSpans.length < maxSpans) {
          badSpans.push({ from: runFrom, to: index });
        }
        runFrom = -1;
      }
    }
    index += 1;
  }
  if (runFrom >= 0 && badSpans.length < maxSpans) {
    badSpans.push({ from: runFrom, to: index });
  }

  return {
    count: values.length,
    nan,
    posInf,
    negInf,
    nonFinite: nan + posInf + negInf,
    min: finite > 0 ? min : null,
    max: finite > 0 ? max : null,
    meanAbs: finite > 0 ? absSum / finite : null,
    peak: finite > 0 ? Math.max(Math.abs(min), Math.abs(max)) : null,
    badSpans,
  };
}

export interface AxisProfile {
  readonly axis: number;
  readonly extent: number;
  /** Positions along this axis holding at least one non-finite element. */
  readonly badPositions: number;
  readonly firstBad: number | null;
  readonly lastBad: number | null;
}

/**
 * Where the non-finite elements sit, one axis at a time.
 *
 * This is the diagnostic that separates causes. "8 of 512 along axis 0, all of
 * every other axis" is whole slices missing, which points at dispatch or at a
 * buffer that was never written. "Scattered across every axis" points at
 * arithmetic, an overflow for instance.
 */
export function axisProfile(values: Float32Array, dims: readonly number[]): readonly AxisProfile[] {
  let elements = 1;
  for (const dim of dims) {
    elements *= dim;
  }
  const shape = elements === values.length && dims.length > 0 ? dims : [values.length];

  const strides: number[] = [];
  let stride = 1;
  for (let axis = shape.length - 1; axis >= 0; axis -= 1) {
    strides[axis] = stride;
    stride *= shape[axis] ?? 1;
  }
  const marks = shape.map((extent) => new Uint8Array(extent));

  let index = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      for (let axis = 0; axis < shape.length; axis += 1) {
        const extent = shape[axis] ?? 1;
        const position = Math.floor(index / (strides[axis] ?? 1)) % extent;
        const mark = marks[axis];
        if (mark !== undefined) {
          mark[position] = 1;
        }
      }
    }
    index += 1;
  }

  return shape.map((extent, axis) => {
    const mark = marks[axis] ?? new Uint8Array(0);
    let badPositions = 0;
    let firstBad: number | null = null;
    let lastBad: number | null = null;
    for (let position = 0; position < mark.length; position += 1) {
      if (mark[position] === 1) {
        badPositions += 1;
        firstBad ??= position;
        lastBad = position;
      }
    }
    return { axis, extent, badPositions, firstBad, lastBad };
  });
}

export interface Divergence {
  readonly compared: number;
  readonly bothFinite: number;
  readonly maxAbs: number;
  readonly maxRel: number;
  /** Index of the worst relative difference, or -1 if nothing compared. */
  readonly atIndex: number;
  /** Elements whose relative difference exceeds the tolerance. */
  readonly beyond: number;
  readonly referenceOnlyBad: number;
  readonly candidateOnlyBad: number;
  readonly lengthMismatch: boolean;
}

/**
 * How far `candidate` has drifted from `reference`, relatively, with an
 * absolute floor so near-zero references do not report an enormous ratio.
 */
export function divergence(
  reference: Float32Array,
  candidate: Float32Array,
  tolerance: number,
  floor = 1e-3,
): Divergence {
  const compared = Math.min(reference.length, candidate.length);
  let bothFinite = 0;
  let maxAbs = 0;
  let maxRel = 0;
  let atIndex = -1;
  let beyond = 0;
  let referenceOnlyBad = 0;
  let candidateOnlyBad = 0;

  for (let i = 0; i < compared; i += 1) {
    const left = reference[i] ?? 0;
    const right = candidate[i] ?? 0;
    const leftOk = Number.isFinite(left);
    const rightOk = Number.isFinite(right);
    if (!leftOk || !rightOk) {
      if (leftOk) {
        candidateOnlyBad += 1;
      } else if (rightOk) {
        referenceOnlyBad += 1;
      }
      continue;
    }
    bothFinite += 1;
    const absolute = Math.abs(left - right);
    const relative = absolute / Math.max(floor, Math.abs(left));
    maxAbs = Math.max(maxAbs, absolute);
    if (relative > maxRel) {
      maxRel = relative;
      atIndex = i;
    }
    if (relative > tolerance) {
      beyond += 1;
    }
  }

  return {
    compared,
    bothFinite,
    maxAbs,
    maxRel,
    atIndex,
    beyond,
    referenceOnlyBad,
    candidateOnlyBad,
    lengthMismatch: reference.length !== candidate.length,
  };
}

export type Verdict = 'clean' | 'diverged' | 'non-finite' | 'failed';

/**
 * One word for a tensor pair. Non-finite beats divergence: a NaN is the thing
 * being hunted, and a NaN also makes the divergence figure meaningless.
 *
 * A stray element in a large tensor is noise, so divergence needs
 * `beyondFraction` of the elements, and at least two of them. It cannot be
 * noise when it is every element there is, though, and that exception is what
 * makes the verdict usable on the scalars of a normalisation: a mean or a
 * standard deviation is a tensor of one, and without it a statistic that came
 * back as the wrong number entirely still read `clean`.
 */
export function verdictFor(
  candidate: TensorStats,
  drift: Divergence,
  tolerance: number,
  beyondFraction = 1e-4,
): Verdict {
  if (candidate.nonFinite > 0) {
    return 'non-finite';
  }
  const needed = Math.max(2, Math.ceil(drift.compared * beyondFraction));
  const everything = drift.compared > 0 && drift.beyond === drift.compared;
  if (drift.maxRel > tolerance && (drift.beyond >= needed || everything)) {
    return 'diverged';
  }
  return 'clean';
}
