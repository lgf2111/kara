import { describe, expect, it } from 'vitest';

import { createPlayRing } from '../src/audio/play-ring.ts';

/**
 * Samples that say which frame they came from: frame n is n + 1 on the left
 * and -(n + 1) on the right, so anything misplaced by the ring shows up as the
 * wrong number rather than as a plausible one.
 */
function block(startFrame: number, frames: number): Float32Array[] {
  return [
    Float32Array.from({ length: frames }, (_, index) => startFrame + index + 1),
    Float32Array.from({ length: frames }, (_, index) => -(startFrame + index + 1)),
  ];
}

function targets(frames: number): Float32Array[] {
  return [new Float32Array(frames).fill(9), new Float32Array(frames).fill(9)];
}

describe('createPlayRing', () => {
  it('gives back what was written, at the frames it was written to', () => {
    const ring = createPlayRing(2, 16);
    expect(ring.write(0, block(0, 8))).toBe(8);
    expect(ring.writtenTo).toBe(8);
    expect(ring.queuedFrames).toBe(8);

    const into = targets(8);
    expect(ring.read(0, 8, into)).toBe(8);
    expect([...(into[0] ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...(into[1] ?? [])]).toEqual([-1, -2, -3, -4, -5, -6, -7, -8]);
    expect(ring.readTo).toBe(8);
    expect(ring.underrunFrames).toBe(0);
  });

  it('reads a quantum at a time out of a block written whole', () => {
    const ring = createPlayRing(2, 16);
    ring.write(0, block(0, 12));

    const into = targets(4);
    for (let at = 0; at < 12; at += 4) {
      expect(ring.read(at, 4, into)).toBe(4);
      expect([...(into[0] ?? [])]).toEqual([at + 1, at + 2, at + 3, at + 4]);
    }
  });

  it('wraps round the seam without losing a sample', () => {
    const ring = createPlayRing(2, 8);
    const into = targets(4);

    for (let at = 0; at < 20; at += 4) {
      ring.write(at, block(at, 4));
      expect(ring.read(at, 4, into)).toBe(4);
      expect([...(into[0] ?? [])]).toEqual([at + 1, at + 2, at + 3, at + 4]);
    }
    expect(ring.underrunFrames).toBe(0);
  });

  it('underruns into silence when a block has not arrived', () => {
    const ring = createPlayRing(2, 16);
    ring.write(0, block(0, 4));

    const into = targets(8);
    expect(ring.read(0, 8, into)).toBe(4);
    expect([...(into[0] ?? [])]).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    expect(ring.underrunFrames).toBe(4);
    // And the cursor still moved: the player cannot wait for late audio.
    expect(ring.readTo).toBe(8);
  });

  it('fills a gap between blocks with silence rather than with last lap', () => {
    const ring = createPlayRing(2, 16);
    ring.write(0, block(0, 4));
    ring.write(8, block(8, 4));

    const into = targets(12);
    expect(ring.read(0, 12, into)).toBe(12);
    expect([...(into[0] ?? [])]).toEqual([1, 2, 3, 4, 0, 0, 0, 0, 9, 10, 11, 12]);
    expect(ring.gapFrames).toBe(4);
  });

  it('refuses the part of a block that was already due', () => {
    const ring = createPlayRing(2, 16);
    ring.write(0, block(0, 8));
    ring.read(0, 8, targets(8));

    expect(ring.write(4, block(4, 8))).toBe(4);
    expect(ring.lateFrames).toBe(4);

    const into = targets(4);
    expect(ring.read(8, 4, into)).toBe(4);
    expect([...(into[0] ?? [])]).toEqual([9, 10, 11, 12]);
  });

  it('refuses a block further ahead than it can hold', () => {
    const ring = createPlayRing(2, 8);
    ring.write(0, block(0, 4));

    expect(ring.write(12, block(12, 4))).toBe(0);
    expect(ring.aheadFrames).toBe(4);
    expect(ring.writtenTo).toBe(4);
  });

  it('empties on a reset, counters and all', () => {
    const ring = createPlayRing(2, 16);
    ring.write(0, block(0, 8));
    ring.read(0, 12, targets(12));
    expect(ring.underrunFrames).toBe(4);

    ring.reset();
    expect(ring.writtenTo).toBe(0);
    expect(ring.readTo).toBe(0);
    expect(ring.underrunFrames).toBe(0);
    expect(ring.gapFrames).toBe(0);

    ring.write(0, block(100, 4));
    const into = targets(4);
    expect(ring.read(0, 4, into)).toBe(4);
    expect([...(into[0] ?? [])]).toEqual([101, 102, 103, 104]);
  });

  it('zeroes a target before it fills it, so nothing stale is played', () => {
    const ring = createPlayRing(2, 16);
    const into = targets(4);

    expect(ring.read(0, 4, into)).toBe(0);
    expect([...(into[0] ?? [])]).toEqual([0, 0, 0, 0]);
  });

  it('refuses a ring, a block or a read that does not add up', () => {
    expect(() => createPlayRing(0, 16)).toThrow(/channel/u);
    expect(() => createPlayRing(2, 0)).toThrow(/holds nothing/u);

    const ring = createPlayRing(2, 16);
    expect(() => ring.write(0, [new Float32Array(4)])).toThrow(/channels/u);
    expect(() => ring.write(0, [new Float32Array(4), new Float32Array(5)])).toThrow(/lengths/u);
    expect(() => ring.write(-1, block(0, 4))).toThrow(/not on the timeline/u);
    expect(() => ring.read(0, 4, targets(3))).toThrow(/no room/u);
  });
});
