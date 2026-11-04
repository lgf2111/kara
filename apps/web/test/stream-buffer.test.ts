import { describe, expect, it } from 'vitest';

import {
  createBlockTiling,
  createWindowBuffer,
  deinterleave,
  latencyReport,
  streamPlan,
} from '../src/separation/stream-buffer.ts';

/** A window small enough to count on a page, with the same 25% overlap. */
const WINDOW = 20;
const HOP = 15;

/** Samples that say where they came from: 1, 2, 3 ... on the left, -1, -2 ... right. */
const LEFT = Float32Array.from({ length: 200 }, (_, index) => index + 1);
const RIGHT = Float32Array.from({ length: 200 }, (_, index) => -(index + 1));

function expected(from: number, length: number, channel: Float32Array): number[] {
  return [...channel.subarray(from, from + length)];
}

describe('streamPlan', () => {
  it('shares the window and hop out as the stitcher reads them', () => {
    expect(streamPlan(WINDOW, HOP)).toEqual({
      segment: WINDOW,
      stride: HOP,
      fade: WINDOW - HOP,
      total: 0,
    });
  });

  it('allows a hop of a whole window, which is no overlap at all', () => {
    expect(streamPlan(WINDOW, WINDOW).fade).toBe(0);
  });

  it('refuses a hop that would step over audio', () => {
    expect(() => streamPlan(WINDOW, WINDOW + 1)).toThrow(/skip audio/u);
  });

  it('refuses windows and hops that are not whole positive sample counts', () => {
    expect(() => streamPlan(0, HOP)).toThrow(/window/u);
    expect(() => streamPlan(WINDOW, 0)).toThrow(/hop/u);
    expect(() => streamPlan(WINDOW, 1.5)).toThrow(/hop/u);
  });
});

describe('createWindowBuffer', () => {
  it('gathers chunks of any size into windows at the right offsets', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    const left = new Float32Array(WINDOW);
    const right = new Float32Array(WINDOW);

    for (const size of [7, 1, 3, 13]) {
      const at = buffer.pushed;
      buffer.push(LEFT.subarray(at, at + size), RIGHT.subarray(at, at + size));
    }
    expect(buffer.pushed).toBe(24);
    expect(buffer.pending).toBe(24);
    expect(buffer.cursor).toBe(0);

    expect(buffer.take(left, right)).toBe(0);
    expect([...left]).toEqual(expected(0, WINDOW, LEFT));
    expect([...right]).toEqual(expected(0, WINDOW, RIGHT));
    // One hop consumed, so the overlap waits for the next window.
    expect(buffer.cursor).toBe(HOP);
    expect(buffer.pending).toBe(24 - HOP);
  });

  it('keeps the overlap for the next window', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    buffer.push(LEFT.subarray(0, 100), RIGHT.subarray(0, 100));
    const left = new Float32Array(WINDOW);
    const right = new Float32Array(WINDOW);

    expect(buffer.take(left, right)).toBe(0);
    expect(buffer.take(left, right)).toBe(HOP);
    expect([...left]).toEqual(expected(HOP, WINDOW, LEFT));
    expect(buffer.take(left, right)).toBe(2 * HOP);
    expect([...left]).toEqual(expected(2 * HOP, WINDOW, LEFT));
    expect(buffer.pending).toBe(100 - 3 * HOP);
  });

  it('zero-pads a window the audio ended inside', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    buffer.push(LEFT.subarray(0, WINDOW - 2), RIGHT.subarray(0, WINDOW - 2));
    const left = new Float32Array(WINDOW);
    const right = new Float32Array(WINDOW);

    expect(buffer.take(left, right)).toBe(0);
    expect([...left]).toEqual([...expected(0, WINDOW - 2, LEFT), 0, 0]);
    expect([...right]).toEqual([...expected(0, WINDOW - 2, RIGHT), 0, 0]);
    // The cursor still moved a whole hop, which is what makes the blocks
    // coming out tile: only what was left over stays pending.
    expect(buffer.cursor).toBe(HOP);
    expect(buffer.pending).toBe(WINDOW - 2 - HOP);
  });

  it('returns null when nothing at all is pending', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    expect(buffer.take(new Float32Array(WINDOW), new Float32Array(WINDOW))).toBeNull();
  });

  it('fills a target longer than a window and clears the rest of it', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    buffer.push(LEFT.subarray(0, WINDOW), RIGHT.subarray(0, WINDOW));
    const left = new Float32Array(WINDOW * 2).fill(9);
    const right = new Float32Array(WINDOW * 2).fill(9);

    expect(buffer.take(left, right)).toBe(0);
    expect([...left.subarray(0, WINDOW)]).toEqual(expected(0, WINDOW, LEFT));
    expect([...left.subarray(WINDOW)]).toEqual(Array.from({ length: WINDOW }, () => 0));
  });

  it('rebases the timeline on a reset, for a seek', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    buffer.push(LEFT.subarray(0, WINDOW), RIGHT.subarray(0, WINDOW));
    buffer.reset(44100);

    expect(buffer.pending).toBe(0);
    expect(buffer.pushed).toBe(44100);
    buffer.push(LEFT.subarray(0, WINDOW), RIGHT.subarray(0, WINDOW));
    expect(buffer.take(new Float32Array(WINDOW), new Float32Array(WINDOW))).toBe(44100);
  });

  it('refuses a chunk whose channels disagree about how long it is', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    expect(() => buffer.push(new Float32Array(4), new Float32Array(5))).toThrow(/left samples/u);
  });

  it('refuses a target with no room for a window', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    buffer.push(LEFT.subarray(0, WINDOW), RIGHT.subarray(0, WINDOW));
    expect(() => buffer.take(new Float32Array(WINDOW - 1), new Float32Array(WINDOW))).toThrow(
      /room/u,
    );
  });

  it('ignores an empty chunk', () => {
    const buffer = createWindowBuffer(WINDOW, HOP);
    buffer.push(new Float32Array(0), new Float32Array(0));
    expect(buffer.pushed).toBe(0);
  });
});

describe('createBlockTiling', () => {
  it('takes blocks that carry on from each other', () => {
    const tiling = createBlockTiling(0);
    tiling.accept(0, HOP);
    tiling.accept(HOP, HOP);
    tiling.accept(2 * HOP, 4);
    expect(tiling.end).toBe(2 * HOP + 4);
  });

  it('refuses a gap', () => {
    const tiling = createBlockTiling(0);
    tiling.accept(0, HOP);
    expect(() => tiling.accept(HOP + 1, HOP)).toThrow(/gap/u);
  });

  it('refuses audio counted twice', () => {
    const tiling = createBlockTiling(0);
    tiling.accept(0, HOP);
    expect(() => tiling.accept(HOP - 1, HOP)).toThrow(/repeats/u);
  });

  it('refuses an empty block', () => {
    expect(() => createBlockTiling(0).accept(0, 0)).toThrow(/nothing in it/u);
  });

  it('starts wherever a seek left it', () => {
    const tiling = createBlockTiling(500);
    expect(tiling.end).toBe(500);
    tiling.accept(500, 10);
    tiling.reset(0);
    tiling.accept(0, 10);
    expect(tiling.end).toBe(10);
  });
});

describe('latencyReport', () => {
  const input = {
    windowSamples: 44100 * 5,
    hopSamples: 44100 * 2,
    sampleRate: 44100,
    computeMs: 900,
    pushedSamples: 44100 * 8,
    emittedSamples: 44100 * 2,
  };

  it('counts a window plus a hop plus what a window costs to compute', () => {
    const report = latencyReport(input);

    expect(report.totalLagMs).toBeCloseTo(7900, 6);
    expect(report.computeMs).toBe(900);
    expect(report.bufferSamples).toBe(44100 * 6);
  });

  it('comes down to the window alone as the hop and the compute shrink', () => {
    expect(
      latencyReport({ ...input, windowSamples: 44100, hopSamples: 1, computeMs: 0 }).totalLagMs,
    ).toBeCloseTo(1000 + 1000 / 44100, 6);
  });

  it('never reports a negative buffer', () => {
    expect(
      latencyReport({ ...input, emittedSamples: input.pushedSamples + 10 }).bufferSamples,
    ).toBe(0);
  });
});

describe('deinterleave', () => {
  it('splits interleaved stereo into two channels', () => {
    const left = new Float32Array(3);
    const right = new Float32Array(3);
    deinterleave(Float32Array.from([1, -1, 2, -2, 3, -3]), 3, left, right);

    expect([...left]).toEqual([1, 2, 3]);
    expect([...right]).toEqual([-1, -2, -3]);
  });

  it('leaves the rest of a longer target alone', () => {
    const left = Float32Array.from([9, 9, 9]);
    const right = Float32Array.from([9, 9, 9]);
    deinterleave(Float32Array.from([1, -1, 2, -2]), 2, left, right);

    expect([...left]).toEqual([1, 2, 9]);
    expect([...right]).toEqual([-1, -2, 9]);
  });
});
