/**
 * The frames waiting to be shown, and the arithmetic that keeps them from
 * eating the machine.
 *
 * Delaying a picture by eighteen seconds means holding eighteen seconds of it.
 * There is no way around that, so the only question is what it costs, and that
 * is a budget rather than a length: a budget is the quantity a person cares
 * about, and the number of frames it buys falls out of the frame size, which
 * depends on the video. `frame-store.ts` is what sets the real one, and its
 * header is the story of why holding decoded pixels was the wrong answer.
 *
 * When the budget is spent the oldest frame goes. Dropping the oldest is the
 * only sane end to drop from: the newest frame is the one the delay has not
 * reached yet, so throwing it away would mean throwing away the future, and
 * the oldest is a frame that is about to expire anyway. A ring that is too
 * small for the delay shows a picture that is less delayed than asked for,
 * which is visible and measurable, rather than one that stutters.
 *
 * Generic over the frame, and with nothing in it that touches the DOM, so the
 * eviction and the picking can be tested on numbers. The frame type is
 * anything with `close`, because some kinds of frame hold memory outside the
 * heap and letting the collector find those is how an overlay becomes a leak.
 */

/** An `ImageBitmap`, as far as this file is concerned. */
export interface Closable {
  close: () => void;
}

export interface Held<T> {
  /** When the frame was displayed, on the shared wall clock, in ms. */
  readonly stamp: number;
  /** What it costs to hold, in bytes. */
  readonly bytes: number;
  readonly frame: T;
}

/**
 * A backstop, for a caller that names no budget. Everything in this extension
 * names one: `frame-store.ts` holds the number that matters.
 */
export const DEFAULT_BUDGET_BYTES = 48 * 1024 * 1024;

/** What one decoded frame of this size occupies: four bytes a pixel. */
export function frameBytes(width: number, height: number): number {
  const w = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  const h = Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
  return w * h * 4;
}

/** How many frames of that size the budget holds. At least one. */
export function budgetFrames(budgetBytes: number, bytesPerFrame: number): number {
  if (!Number.isFinite(budgetBytes) || !Number.isFinite(bytesPerFrame) || bytesPerFrame <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(budgetBytes / bytesPerFrame));
}

/**
 * And how many seconds of picture that is, which is the number to hold against
 * the delay before believing any of it.
 */
export function budgetSeconds(
  budgetBytes: number,
  bytesPerFrame: number,
  fps: number,
): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  return budgetFrames(budgetBytes, bytesPerFrame) / fps;
}

/**
 * The newest frame that was already on screen at `stamp`, by index, or -1 if
 * every frame held is newer than that.
 *
 * At or before, never after: showing a frame from the future is the one error
 * that cannot be excused as lag. Binary search because this runs on every
 * animation frame against a few hundred frames.
 */
export function indexAtOrBefore(
  held: readonly { readonly stamp: number }[],
  stamp: number,
): number {
  let low = 0;
  let high = held.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const at = held[middle];
    if (at === undefined || at.stamp > stamp) {
      high = middle - 1;
    } else {
      found = middle;
      low = middle + 1;
    }
  }
  return found;
}

export interface FrameRing<T extends Closable> {
  readonly frames: number;
  readonly bytes: number;
  /** Frames closed because the budget was spent, since the last clear. */
  readonly dropped: number;
  /**
   * Adds a frame. Out of order is allowed and sorted into place, because
   * `createImageBitmap` is a promise and two of them can finish the wrong way
   * round.
   */
  push: (frame: T, stamp: number, bytes: number) => void;
  /** The frame to show at `stamp`, or null if none is old enough yet. */
  at: (stamp: number) => Held<T> | null;
  /**
   * Every frame held between two stamps, oldest first, including the one
   * `at(from)` would return. What a decode look-ahead reads: the frames about
   * to be wanted, which is the only reason to spend memory on a decoded one.
   */
  window: (from: number, to: number) => readonly Held<T>[];
  oldest: () => Held<T> | null;
  newest: () => Held<T> | null;
  /**
   * Closes every frame older than the one `at(stamp)` would return. What is
   * left is what the delay can still reach.
   */
  trim: (stamp: number) => void;
  clear: () => void;
}

export interface RingOptions {
  readonly budgetBytes?: number;
}

export function createFrameRing<T extends Closable>(options: RingOptions = {}): FrameRing<T> {
  const asked = options.budgetBytes;
  const budget =
    asked !== undefined && Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_BUDGET_BYTES;

  const held: Held<T>[] = [];
  let bytes = 0;
  let dropped = 0;

  const shed = (count: number): void => {
    for (const gone of held.splice(0, count)) {
      bytes -= gone.bytes;
      gone.frame.close();
    }
  };

  return {
    get frames() {
      return held.length;
    },
    get bytes() {
      return bytes;
    },
    get dropped() {
      return dropped;
    },

    push(frame, stamp, frameSize) {
      if (!Number.isFinite(stamp)) {
        // A frame nobody can place in time is worse than no frame.
        frame.close();
        return;
      }
      const size = Number.isFinite(frameSize) ? Math.max(0, frameSize) : 0;
      held.splice(indexAtOrBefore(held, stamp) + 1, 0, { stamp, bytes: size, frame });
      bytes += size;
      // One frame always stays, however big it is: a budget smaller than a
      // single frame is a reason to show a stale picture, not no picture.
      while (bytes > budget && held.length > 1) {
        shed(1);
        dropped += 1;
      }
    },

    at(stamp) {
      return held[indexAtOrBefore(held, stamp)] ?? null;
    },

    window(from, to) {
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
        return [];
      }
      const first = Math.max(0, indexAtOrBefore(held, from));
      const last = indexAtOrBefore(held, to);
      return last < first ? [] : held.slice(first, last + 1);
    },

    oldest() {
      return held[0] ?? null;
    },

    newest() {
      return held[held.length - 1] ?? null;
    },

    trim(stamp) {
      const keep = indexAtOrBefore(held, stamp);
      if (keep > 0) {
        shed(keep);
      }
    },

    clear() {
      shed(held.length);
      bytes = 0;
      dropped = 0;
    },
  };
}
