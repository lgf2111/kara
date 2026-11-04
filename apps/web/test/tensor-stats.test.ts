import { describe, expect, it } from 'vitest';

import {
  FP16_MAX,
  axisProfile,
  divergence,
  halfToFloat,
  tensorStats,
  toFloat32,
  verdictFor,
} from '../src/diagnostics/tensor-stats.ts';

describe('halfToFloat', () => {
  it('reads the halves that matter for an overflow story', () => {
    expect(halfToFloat(0x0000)).toBe(0);
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x7bff)).toBe(FP16_MAX);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0xfc00)).toBe(-Infinity);
    expect(Number.isNaN(halfToFloat(0x7e00))).toBe(true);
  });

  it('reads a subnormal', () => {
    expect(halfToFloat(0x0001)).toBeCloseTo(2 ** -24, 30);
  });
});

describe('toFloat32', () => {
  it('passes float32 through without copying', () => {
    const values = Float32Array.from([1, 2, 3]);

    expect(toFloat32(values)).toBe(values);
  });

  it('treats a Uint16Array as fp16 halves', () => {
    expect([...toFloat32(Uint16Array.from([0x3c00, 0xc000, 0x7c00]))]).toEqual([1, -2, Infinity]);
  });

  it('reads any other view element by element', () => {
    expect([...toFloat32(BigInt64Array.from([1n, -2n]))]).toEqual([1, -2]);
    expect([...toFloat32(Int32Array.from([7, -8]))]).toEqual([7, -8]);
  });

  it('refuses something that is not a view', () => {
    expect(() => toFloat32([1, 2, 3])).toThrow(/not an array view/u);
  });
});

describe('tensorStats', () => {
  it('counts each kind of non-finite separately', () => {
    const stats = tensorStats(Float32Array.from([1, NaN, Infinity, -Infinity, NaN, 2]));

    expect(stats.nan).toBe(2);
    expect(stats.posInf).toBe(1);
    expect(stats.negInf).toBe(1);
    expect(stats.nonFinite).toBe(4);
    expect(stats.count).toBe(6);
  });

  it('takes its range over the finite values only', () => {
    const stats = tensorStats(Float32Array.from([-3, NaN, 5, Infinity, 1]));

    expect(stats.min).toBe(-3);
    expect(stats.max).toBe(5);
    expect(stats.peak).toBe(5);
    expect(stats.meanAbs).toBeCloseTo(3, 6);
  });

  it('has no range at all when nothing is finite', () => {
    const stats = tensorStats(Float32Array.from([NaN, NaN]));

    expect(stats.min).toBeNull();
    expect(stats.max).toBeNull();
    expect(stats.peak).toBeNull();
    expect(stats.meanAbs).toBeNull();
  });

  it('collapses the bad elements into runs, including one that ends the tensor', () => {
    const stats = tensorStats(Float32Array.from([0, NaN, NaN, 0, 0, NaN]));

    expect(stats.badSpans).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 6 },
    ]);
  });

  it('stops after the span limit rather than listing a million of them', () => {
    const values = new Float32Array(100);
    for (let i = 0; i < values.length; i += 2) {
      values[i] = NaN;
    }

    expect(tensorStats(values, 3).badSpans).toHaveLength(3);
    expect(tensorStats(values, 3).nonFinite).toBe(50);
  });
});

describe('axisProfile', () => {
  it('finds whole slices missing along one axis', () => {
    // [4, 3], with row 2 entirely non-finite: dispatch or an unwritten buffer.
    const values = new Float32Array(12);
    for (let i = 0; i < 3; i += 1) {
      values[2 * 3 + i] = NaN;
    }

    expect(axisProfile(values, [4, 3])).toEqual([
      { axis: 0, extent: 4, badPositions: 1, firstBad: 2, lastBad: 2 },
      { axis: 1, extent: 3, badPositions: 3, firstBad: 0, lastBad: 2 },
    ]);
  });

  it('spreads across every axis when the arithmetic is what went wrong', () => {
    // (0,0), (1,2) and (2,1): no slice is missing, the values are just wrong.
    const values = new Float32Array(12);
    values[0] = NaN;
    values[5] = NaN;
    values[7] = NaN;

    expect(axisProfile(values, [4, 3]).map((axis) => axis.badPositions)).toEqual([3, 3]);
  });

  it('falls back to one flat axis when the dims do not fit', () => {
    const values = Float32Array.from([0, NaN, 0]);

    expect(axisProfile(values, [2, 7])).toEqual([
      { axis: 0, extent: 3, badPositions: 1, firstBad: 1, lastBad: 1 },
    ]);
  });
});

describe('divergence', () => {
  it('is nothing for two identical tensors', () => {
    const values = Float32Array.from([1, -2, 0.5]);
    const drift = divergence(values, Float32Array.from(values), 1e-3);

    expect(drift.maxAbs).toBe(0);
    expect(drift.maxRel).toBe(0);
    expect(drift.beyond).toBe(0);
    expect(drift.bothFinite).toBe(3);
  });

  it('measures relatively, with a floor so a near-zero reference is not a cliff', () => {
    const drift = divergence(
      Float32Array.from([1, 1e-9]),
      Float32Array.from([1.5, 1e-4]),
      0.1,
      1e-3,
    );

    expect(drift.maxAbs).toBeCloseTo(0.5, 6);
    // 0.5 against a reference of 1 beats 1e-4 against the 1e-3 floor.
    expect(drift.maxRel).toBeCloseTo(0.5, 6);
    expect(drift.atIndex).toBe(0);
    expect(drift.beyond).toBe(1);
  });

  it('keeps the two directions of non-finite apart', () => {
    const drift = divergence(Float32Array.from([1, NaN, 3]), Float32Array.from([1, 2, NaN]), 1e-3);

    expect(drift.candidateOnlyBad).toBe(1);
    expect(drift.referenceOnlyBad).toBe(1);
    expect(drift.bothFinite).toBe(1);
  });

  it('compares what it can when the lengths differ and says so', () => {
    const drift = divergence(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2]), 1e-3);

    expect(drift.compared).toBe(2);
    expect(drift.lengthMismatch).toBe(true);
  });
});

describe('verdictFor', () => {
  const clean = Float32Array.from([1, 2, 3, 4]);

  it('calls a non-finite candidate non-finite whatever the drift says', () => {
    const candidate = Float32Array.from([1, 2, NaN, 4]);

    expect(verdictFor(tensorStats(candidate), divergence(clean, candidate, 1e-3), 1e-3)).toBe(
      'non-finite',
    );
  });

  it('is clean when a single element moves by float32 rounding', () => {
    const candidate = Float32Array.from([1, 2, 3.0000001, 4]);

    expect(verdictFor(tensorStats(candidate), divergence(clean, candidate, 1e-3), 1e-3)).toBe(
      'clean',
    );
  });

  it('is clean for one outlier, because one element is not a miscompiled kernel', () => {
    const candidate = Float32Array.from([1, 2, 9, 4]);

    expect(verdictFor(tensorStats(candidate), divergence(clean, candidate, 1e-3), 1e-3)).toBe(
      'clean',
    );
  });

  it('is diverged when the drift is everywhere', () => {
    const candidate = Float32Array.from([2, 4, 6, 8]);

    expect(verdictFor(tensorStats(candidate), divergence(clean, candidate, 1e-3), 1e-3)).toBe(
      'diverged',
    );
  });
});
