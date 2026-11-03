import { describe, expect, it } from 'vitest';

import { planJob } from '../src/separation/job.ts';
import { createStitcher, finalisedFrames, totalFrames } from '../src/separation/stitch.ts';

/** A plan small enough to reason about by hand. */
const plan = planJob(100, 20, 0.25); // segment 20, stride 15, fade 5

function ramp(length: number, channels: number, offset = 0): Float32Array {
  const out = new Float32Array(length * channels);
  for (let frame = 0; frame < length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      out[frame * channels + channel] = (offset + frame) * 10 + channel;
    }
  }
  return out;
}

/** Runs the whole plan over a source signal, returning the stitched output. */
function stitchAll(
  source: Float32Array,
  channels: number,
  segments: number,
  options: { readonly stopAfter?: number; readonly resumeFrom?: { tail: Float32Array; at: number } } = {},
): { output: number[]; tail: Float32Array } {
  const stitcher = createStitcher(plan, channels);
  const output: number[] = [];
  let first = 0;
  if (options.resumeFrom !== undefined) {
    stitcher.restore(options.resumeFrom.tail);
    first = options.resumeFrom.at;
  }
  const stop = options.stopAfter ?? segments;

  for (let index = first; index < Math.min(segments, stop); index += 1) {
    const start = index * plan.stride;
    const segment = new Float32Array(plan.segment * channels);
    segment.set(source.subarray(start * channels, (start + plan.segment) * channels));
    const released = stitcher.push(segment);
    if (released !== null) {
      output.push(...released);
    }
    if (index === segments - 1) {
      output.push(...stitcher.finish());
    }
  }
  return { output, tail: Float32Array.from(stitcher.tail) };
}

describe('createStitcher', () => {
  it('releases nothing for the first segment and one stride after that', () => {
    const stitcher = createStitcher(plan, 2);
    expect(stitcher.hasTail()).toBe(false);

    expect(stitcher.push(new Float32Array(plan.segment * 2))).toBeNull();
    expect(stitcher.hasTail()).toBe(true);

    const released = stitcher.push(new Float32Array(plan.segment * 2));
    expect(released?.length).toBe(plan.stride * 2);
  });

  it('reproduces the source exactly when neighbouring segments agree', () => {
    const channels = 2;
    const segments = 5;
    const source = ramp(segments * plan.stride + plan.segment, channels);

    const { output } = stitchAll(source, channels, segments);

    expect(output.length).toBe(totalFrames(plan, segments) * channels);
    // Overlapping slices of one signal must crossfade back to that signal: a
    // blend of two identical values is the value, so there is no seam.
    expect(output).toEqual([...source.subarray(0, output.length)]);
  });

  it('counts finalised frames the way the job state does', () => {
    expect(finalisedFrames(plan, 0)).toBe(0);
    expect(finalisedFrames(plan, 1)).toBe(0);
    expect(finalisedFrames(plan, 3)).toBe(2 * plan.stride);
    expect(totalFrames(plan, 3)).toBe(2 * plan.stride + plan.segment);
  });

  it('resumes from a saved tail with the same output as an unbroken run', () => {
    const channels = 2;
    const segments = 6;
    const source = ramp(segments * plan.stride + plan.segment, channels);

    const unbroken = stitchAll(source, channels, segments).output;

    // Stop after three segments, keep what was written and the tail, then
    // carry on in a fresh stitcher as a new tab would.
    const interrupted = stitchAll(source, channels, segments, { stopAfter: 3 });
    const resumed = stitchAll(source, channels, segments, {
      resumeFrom: { tail: interrupted.tail, at: 3 },
    });

    expect(interrupted.output.length).toBe(finalisedFrames(plan, 3) * channels);
    expect([...interrupted.output, ...resumed.output]).toEqual(unbroken);
  });

  it('refuses a tail of the wrong length', () => {
    const stitcher = createStitcher(plan, 2);
    expect(() => stitcher.restore(new Float32Array(3))).toThrow(/expected/u);
  });

  it('handles a single-segment job', () => {
    const channels = 1;
    const source = ramp(plan.segment, channels);
    const { output } = stitchAll(source, channels, 1);
    expect(output).toEqual([...source]);
  });
});
