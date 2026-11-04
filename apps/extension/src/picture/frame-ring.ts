/**
 * The frames waiting to be shown, and the arithmetic that keeps them from
 * eating the machine.
 *
 * Delaying a picture by eighteen seconds means holding eighteen seconds of it.
 * There is no way around that, so the only question is what it costs: frames
 * are downscaled to about 640 px wide before they get here, which is 640 × 360
 * × 4 bytes each, and at fifteen a second eighteen seconds comes to about
 * 250 MB. That is the whole reason this file has a budget in it rather than a
 * length. A budget is the quantity a person cares about, and the number of
 * frames it buys falls out of the frame size, which depends on the video.
 *
 * When the budget is spent the oldest frame goes. Dropping the oldest is the
 * only sane end to drop from: the newest frame is the one the delay has not
 * reached yet, so throwing it away would mean throwing away the future, and
 * the oldest is a frame that is about to expire anyway. A ring that is too
 * small for the delay shows a picture that is less delayed than asked for,
 * which is visible and measurable, rather than one that stutters.
 *
 * Generic over the frame, and with nothing in it that touches the DOM, so the
 * eviction and the picking can be tested on numbers. The real thing holds
 * `ImageBitmap`s, which have to be closed by hand — they are a handle on
 * memory outside the heap, and letting the garbage collector find them is how
 * an overlay turns into a leak — so the frame type is anything with `close`.
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
 * Under 300 MB, which is the budget this is allowed. At 640 × 360 it buys
 * about 21 s at 15 fps, which covers the eighteen the audio asks for with a
 * little room to spare.
 */
export const DEFAULT_BUDGET_BYTES = 280 * 1024 * 1024;

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
