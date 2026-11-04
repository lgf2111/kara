import { describe, expect, it } from 'vitest';

import {
  budgetFrames,
  budgetSeconds,
  createFrameRing,
  frameBytes,
  indexAtOrBefore,
} from '../src/picture/frame-ring.ts';

/** An `ImageBitmap` as far as the ring is concerned: a thing that closes. */
interface Fake {
  readonly id: number;
  closed: boolean;
  close: () => void;
}

function fake(id: number): Fake {
  const made: Fake = {
    id,
    closed: false,
    close: () => {
      made.closed = true;
    },
  };
  return made;
}

/** A hundred bytes a frame, so a budget is a number of frames by eye. */
const BYTES = 100;

describe('frameBytes', () => {
  it('counts four bytes a pixel', () => {
    expect(frameBytes(640, 360)).toBe(921_600);
    expect(frameBytes(2, 3)).toBe(24);
  });

  it('treats a size it cannot read as nothing', () => {
    expect(frameBytes(Number.NaN, 360)).toBe(0);
    expect(frameBytes(-10, 360)).toBe(0);
  });
});

describe('budgetFrames and budgetSeconds', () => {
  it('holds the delay the audio asks for within the budget it is given', () => {
    const under300MB = 280 * 1024 * 1024;
    const held = budgetSeconds(under300MB, frameBytes(640, 360), 15);

    // Eighteen is what the audio settles on; the budget has to beat it.
    expect(held).toBeGreaterThan(18);
    expect(under300MB).toBeLessThan(300_000_000);
  });

  it('buys fewer frames as they get bigger', () => {
    expect(budgetFrames(1000, 100)).toBe(10);
    expect(budgetFrames(1000, 400)).toBe(2);
  });

  it('always allows one frame, however small the budget', () => {
    expect(budgetFrames(10, 1_000_000)).toBe(1);
    expect(budgetFrames(Number.NaN, 100)).toBe(1);
    expect(budgetFrames(1000, 0)).toBe(1);
  });

  it('says no seconds when the frame rate is not one', () => {
    expect(budgetSeconds(1000, 100, 0)).toBe(0);
    expect(budgetSeconds(1000, 100, Number.NaN)).toBe(0);
  });
});

describe('indexAtOrBefore', () => {
  const stamps = [{ stamp: 10 }, { stamp: 20 }, { stamp: 30 }, { stamp: 40 }];

  it('takes the frame that was already on screen, never the next one', () => {
    expect(indexAtOrBefore(stamps, 25)).toBe(1);
    expect(indexAtOrBefore(stamps, 29.999)).toBe(1);
    expect(indexAtOrBefore(stamps, 30)).toBe(2);
  });

  it('takes the newest when every frame is old enough', () => {
    expect(indexAtOrBefore(stamps, 1000)).toBe(3);
  });

  it('takes nothing when every frame is from the future', () => {
    expect(indexAtOrBefore(stamps, 9)).toBe(-1);
    expect(indexAtOrBefore([], 100)).toBe(-1);
  });
});

describe('createFrameRing', () => {
  it('gives back the frame that was on screen at the asked-for moment', () => {
    const ring = createFrameRing<Fake>();
    ring.push(fake(1), 1000, BYTES);
    ring.push(fake(2), 2000, BYTES);
    ring.push(fake(3), 3000, BYTES);

    expect(ring.at(2500)?.frame.id).toBe(2);
    expect(ring.at(3000)?.frame.id).toBe(3);
    expect(ring.at(999)).toBeNull();
    expect(ring.oldest()?.frame.id).toBe(1);
    expect(ring.newest()?.frame.id).toBe(3);
    expect(ring.frames).toBe(3);
    expect(ring.bytes).toBe(3 * BYTES);
  });

  it('drops the oldest when the budget is spent, and closes it', () => {
    const ring = createFrameRing<Fake>({ budgetBytes: 3 * BYTES });
    const first = fake(1);
    ring.push(first, 1000, BYTES);
    ring.push(fake(2), 2000, BYTES);
    ring.push(fake(3), 3000, BYTES);
    expect(ring.dropped).toBe(0);
    expect(first.closed).toBe(false);

    ring.push(fake(4), 4000, BYTES);

    expect(first.closed).toBe(true);
    expect(ring.frames).toBe(3);
    expect(ring.bytes).toBe(3 * BYTES);
    expect(ring.dropped).toBe(1);
    // The future is kept and the past is spent, which is the only way round
    // that leaves anything to paint.
    expect(ring.oldest()?.frame.id).toBe(2);
    expect(ring.newest()?.frame.id).toBe(4);
  });

  it('keeps one frame however badly it overshoots the budget', () => {
    const ring = createFrameRing<Fake>({ budgetBytes: 10 });

    ring.push(fake(1), 1000, 5000);
    ring.push(fake(2), 2000, 5000);

    expect(ring.frames).toBe(1);
    expect(ring.newest()?.frame.id).toBe(2);
  });

  it('sorts a frame that decoded out of order into its place', () => {
    const ring = createFrameRing<Fake>();
    ring.push(fake(1), 1000, BYTES);
    ring.push(fake(3), 3000, BYTES);
    ring.push(fake(2), 2000, BYTES);

    expect(ring.at(2500)?.frame.id).toBe(2);
    expect(ring.newest()?.frame.id).toBe(3);
  });

  it('refuses a frame with no time on it rather than holding it for ever', () => {
    const ring = createFrameRing<Fake>();
    const lost = fake(1);

    ring.push(lost, Number.NaN, BYTES);

    expect(ring.frames).toBe(0);
    expect(lost.closed).toBe(true);
  });

  it('trims what the delay can no longer reach, and keeps what it can', () => {
    const ring = createFrameRing<Fake>();
    const frames = [fake(1), fake(2), fake(3), fake(4)];
    frames.forEach((frame, index) => {
      ring.push(frame, 1000 * (index + 1), BYTES);
    });

    // Painting the moment 2500 needs frame 2 and everything after it.
    ring.trim(2500);

    expect(ring.frames).toBe(3);
    expect(frames[0]?.closed).toBe(true);
    expect(frames[1]?.closed).toBe(false);
    expect(ring.at(2500)?.frame.id).toBe(2);
  });

  it('trims nothing when the oldest frame is still the one wanted', () => {
    const ring = createFrameRing<Fake>();
    ring.push(fake(1), 1000, BYTES);
    ring.push(fake(2), 2000, BYTES);

    ring.trim(1500);
    expect(ring.frames).toBe(2);

    // And nothing when none of them is old enough to paint at all.
    ring.trim(0);
    expect(ring.frames).toBe(2);
  });

  it('closes everything on a clear, because nothing else will', () => {
    const ring = createFrameRing<Fake>({ budgetBytes: BYTES });
    const frames = [fake(1), fake(2), fake(3)];
    frames.forEach((frame, index) => {
      ring.push(frame, 1000 * (index + 1), BYTES);
    });
    expect(ring.dropped).toBe(2);

    ring.clear();

    expect(ring.frames).toBe(0);
    expect(ring.bytes).toBe(0);
    expect(ring.dropped).toBe(0);
    expect(frames.every((frame) => frame.closed)).toBe(true);
  });
});
