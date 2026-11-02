/**
 * Complex transforms for the separation host code.
 *
 * Two of the candidate models need an FFT whose length is not a power of two
 * (MDX-Net uses n_fft 7680), so there is a radix-2 transform for the sizes that
 * are, and Bluestein's chirp-z algorithm on top of it for the sizes that are
 * not. Everything runs in Float64Array internally: the chirp phases for a
 * 7680-point transform lose too much precision in float32.
 */

export interface ComplexTransform {
  readonly size: number;
  /** In place, unscaled. */
  forward(re: Float64Array, im: Float64Array): void;
  /** In place, scaled by 1/size. */
  inverse(re: Float64Array, im: Float64Array): void;
}

export function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

export function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) {
    result *= 2;
  }
  return result;
}

function radix2(size: number): ComplexTransform {
  if (!isPowerOfTwo(size)) {
    throw new Error(`radix2 needs a power of two, got ${String(size)}`);
  }

  const levels = Math.log2(size);
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i += 1) {
    cos[i] = Math.cos((-2 * Math.PI * i) / size);
    sin[i] = Math.sin((-2 * Math.PI * i) / size);
  }

  const reversed = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) {
    let value = i;
    let bits = 0;
    for (let bit = 0; bit < levels; bit += 1) {
      bits = (bits << 1) | (value & 1);
      value >>>= 1;
    }
    reversed[i] = bits;
  }

  function transform(re: Float64Array, im: Float64Array): void {
    for (let i = 0; i < size; i += 1) {
      const j = reversed[i] ?? 0;
      if (j > i) {
        const tre = re[i] ?? 0;
        const tim = im[i] ?? 0;
        re[i] = re[j] ?? 0;
        im[i] = im[j] ?? 0;
        re[j] = tre;
        im[j] = tim;
      }
    }

    for (let span = 2; span <= size; span *= 2) {
      const half = span / 2;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let offset = 0; offset < half; offset += 1) {
          const twiddle = offset * step;
          const wr = cos[twiddle] ?? 0;
          const wi = sin[twiddle] ?? 0;
          const a = start + offset;
          const b = a + half;
          const xr = re[b] ?? 0;
          const xi = im[b] ?? 0;
          const tre = xr * wr - xi * wi;
          const tim = xr * wi + xi * wr;
          re[b] = (re[a] ?? 0) - tre;
          im[b] = (im[a] ?? 0) - tim;
          re[a] = (re[a] ?? 0) + tre;
          im[a] = (im[a] ?? 0) + tim;
        }
      }
    }
  }

  return {
    size,
    forward: transform,
    inverse(re, im) {
      transform(im, re); // swapping the parts conjugates in both directions
      const scale = 1 / size;
      for (let i = 0; i < size; i += 1) {
        re[i] = (re[i] ?? 0) * scale;
        im[i] = (im[i] ?? 0) * scale;
      }
    },
  };
}

function bluestein(size: number): ComplexTransform {
  const padded = nextPowerOfTwo(size * 2 - 1);
  const inner = radix2(padded);

  // exp(-i*pi*k^2/size), with k^2 reduced modulo 2*size so the angle keeps its
  // precision for large k.
  const chirpRe = new Float64Array(size);
  const chirpIm = new Float64Array(size);
  for (let k = 0; k < size; k += 1) {
    const angle = (-Math.PI * ((k * k) % (size * 2))) / size;
    chirpRe[k] = Math.cos(angle);
    chirpIm[k] = Math.sin(angle);
  }

  const kernelRe = new Float64Array(padded);
  const kernelIm = new Float64Array(padded);
  kernelRe[0] = chirpRe[0] ?? 0;
  kernelIm[0] = -(chirpIm[0] ?? 0);
  for (let k = 1; k < size; k += 1) {
    const re = chirpRe[k] ?? 0;
    const im = -(chirpIm[k] ?? 0);
    kernelRe[k] = re;
    kernelIm[k] = im;
    kernelRe[padded - k] = re;
    kernelIm[padded - k] = im;
  }
  inner.forward(kernelRe, kernelIm);

  const workRe = new Float64Array(padded);
  const workIm = new Float64Array(padded);

  function transform(re: Float64Array, im: Float64Array): void {
    workRe.fill(0);
    workIm.fill(0);
    for (let k = 0; k < size; k += 1) {
      const xr = re[k] ?? 0;
      const xi = im[k] ?? 0;
      const cr = chirpRe[k] ?? 0;
      const ci = chirpIm[k] ?? 0;
      workRe[k] = xr * cr - xi * ci;
      workIm[k] = xr * ci + xi * cr;
    }

    inner.forward(workRe, workIm);
    for (let i = 0; i < padded; i += 1) {
      const ar = workRe[i] ?? 0;
      const ai = workIm[i] ?? 0;
      const br = kernelRe[i] ?? 0;
      const bi = kernelIm[i] ?? 0;
      workRe[i] = ar * br - ai * bi;
      workIm[i] = ar * bi + ai * br;
    }
    inner.inverse(workRe, workIm);

    for (let k = 0; k < size; k += 1) {
      const yr = workRe[k] ?? 0;
      const yi = workIm[k] ?? 0;
      const cr = chirpRe[k] ?? 0;
      const ci = chirpIm[k] ?? 0;
      re[k] = yr * cr - yi * ci;
      im[k] = yr * ci + yi * cr;
    }
  }

  return {
    size,
    forward: transform,
    inverse(re, im) {
      for (let k = 0; k < size; k += 1) {
        im[k] = -(im[k] ?? 0);
      }
      transform(re, im);
      const scale = 1 / size;
      for (let k = 0; k < size; k += 1) {
        re[k] = (re[k] ?? 0) * scale;
        im[k] = -(im[k] ?? 0) * scale;
      }
    },
  };
}

const cache = new Map<number, ComplexTransform>();

export function complexTransform(size: number): ComplexTransform {
  const existing = cache.get(size);
  if (existing !== undefined) {
    return existing;
  }
  if (size < 1) {
    throw new Error(`transform size must be positive, got ${String(size)}`);
  }
  const created = isPowerOfTwo(size) ? radix2(size) : bluestein(size);
  cache.set(size, created);
  return created;
}

/** Naive transform, for tests to check the fast ones against. */
export function naiveDft(re: readonly number[], im: readonly number[]): { re: number[]; im: number[] } {
  const size = re.length;
  const outRe = new Array<number>(size).fill(0);
  const outIm = new Array<number>(size).fill(0);
  for (let k = 0; k < size; k += 1) {
    let sumRe = 0;
    let sumIm = 0;
    for (let n = 0; n < size; n += 1) {
      const angle = (-2 * Math.PI * k * n) / size;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      sumRe += (re[n] ?? 0) * c - (im[n] ?? 0) * s;
      sumIm += (re[n] ?? 0) * s + (im[n] ?? 0) * c;
    }
    outRe[k] = sumRe;
    outIm[k] = sumIm;
  }
  return { re: outRe, im: outIm };
}
