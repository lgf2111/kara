import { budgetSeconds, createFrameRing, type Held } from './frame-ring.ts';

/**
 * Eighteen seconds of picture, held as pictures rather than as pixels.
 *
 * What this replaces cost a quarter of a gigabyte. Every kept frame was an
 * `ImageBitmap` — 640 × 360 × 4 bytes of decoded pixels, which Chromium backs
 * with GPU memory — and eighteen seconds at fifteen a second came to about
 * 250 MB of it. The defence was that the delay has to be held somehow and
 * that is what it costs. The defence was wrong, and the symptom was the one
 * thing worse than memory: the GPU holding those bitmaps is the same GPU
 * running htdemucs and decoding YouTube's video, so the page's own playback
 * went from lagging to crawling, which starved the capture, which starved the
 * separator.
 *
 * So a frame is kept the way a picture is kept everywhere else: compressed.
 * `OffscreenCanvas.convertToBlob` at about 640 px wide and quality 0.6 gives a
 * webp of a few tens of kilobytes, in ordinary heap memory, and the whole
 * eighteen seconds fits in a budget of tens of megabytes with nothing on the
 * GPU at all. One frame is decoded at a time, when it is about to be shown,
 * with a small look-ahead — `frame-codec.ts` — and nothing accumulates.
 *
 * **Keyed by media time, not by the wall clock.** A frame is stamped with
 * `requestVideoFrameCallback`'s `mediaTime`, which is where in the song it
 * belongs, and the audio side reports where in the song its output has
 * reached. Matching those two is the whole of the sync, and it survives
 * everything the wall clock does not: a pause, a buffering stall, an ad, a
 * slow decode. The arithmetic that used to add a pause's length onto a delay
 * is gone, because there is nothing left for it to correct.
 *
 * Eviction is {@link createFrameRing}'s, which drops the oldest when the
 * budget is spent. That is the only sane end to drop from: the newest frame is
 * the one the delay has not reached yet, so losing it would be losing the
 * future, and the oldest is about to expire anyway. A budget too small for the
 * delay therefore shows a picture less delayed than asked for, which is
 * visible and measurable, rather than one that stutters.
 */

/**
 * The budget, which is under 60 MB on purpose: small enough that holding it
 * is not a thing anybody notices, which is the opposite of what it replaced.
 * At about 30 KB a frame it buys over a thousand frames, which is more than a
 * minute at fifteen a second — far more than the delay needs, with room for a
 * video whose frames compress badly.
 */
export const FRAME_BUDGET_BYTES = 48 * 1024 * 1024;

/** What one 640 px webp at quality 0.6 comes to, give or take the picture. */
export const TYPICAL_FRAME_BYTES = 30 * 1024;

/** A frame, and where in the song it belongs. */
export interface StoredFrame<T> {
  /** `requestVideoFrameCallback`'s `mediaTime`, in seconds. */
  readonly mediaSeconds: number;
  readonly bytes: number;
  readonly data: T;
}

export interface FrameStore<T> {
  readonly frames: number;
  readonly bytes: number;
  /** Frames dropped because the budget was spent, since the last clear. */
  readonly dropped: number;
  readonly budgetBytes: number;
  push(data: T, mediaSeconds: number, bytes: number): void;
  /** The frame that was on screen at this point in the song, or null. */
  at(mediaSeconds: number): StoredFrame<T> | null;
  /** The frames about to be wanted, for a decoder to get ahead of. */
  window(fromSeconds: number, toSeconds: number): readonly StoredFrame<T>[];
  oldest(): StoredFrame<T> | null;
  newest(): StoredFrame<T> | null;
  /** Drops everything the delay can no longer reach. */
  trim(mediaSeconds: number): void;
  clear(): void;
}

export interface FrameStoreOptions {
  readonly budgetBytes?: number;
}

/**
 * How many seconds of picture a budget buys at a frame size and rate, which
 * is the number to hold against the delay before believing any of it.
 */
export function storedSeconds(
  budgetBytes = FRAME_BUDGET_BYTES,
  bytesPerFrame = TYPICAL_FRAME_BYTES,
  fps = 15,
): number {
  return budgetSeconds(budgetBytes, bytesPerFrame, fps);
}

/** A payload the ring can hold: compressed frames need no closing. */
interface Payload<T> {
  readonly data: T;
  close: () => void;
}

function hold<T>(data: T): Payload<T> {
  return {
    data,
    close: () => {
      // A blob is heap memory and the collector is welcome to it. The whole
      // reason this file exists is that the thing it replaced was not.
    },
  };
}

function stored<T>(held: Held<Payload<T>> | null): StoredFrame<T> | null {
  if (held === null) {
    return null;
  }
  return { mediaSeconds: held.stamp, bytes: held.bytes, data: held.frame.data };
}

export function createFrameStore<T>(options: FrameStoreOptions = {}): FrameStore<T> {
  const asked = options.budgetBytes;
  const budgetBytes =
    asked !== undefined && Number.isFinite(asked) && asked > 0 ? asked : FRAME_BUDGET_BYTES;
  const ring = createFrameRing<Payload<T>>({ budgetBytes });

  return {
    get frames() {
      return ring.frames;
    },
    get bytes() {
      return ring.bytes;
    },
    get dropped() {
      return ring.dropped;
    },
    budgetBytes,

    push(data, mediaSeconds, bytes) {
      ring.push(hold(data), mediaSeconds, bytes);
    },

    at(mediaSeconds) {
      return stored(ring.at(mediaSeconds));
    },

    window(fromSeconds, toSeconds) {
      const found: StoredFrame<T>[] = [];
      for (const held of ring.window(fromSeconds, toSeconds)) {
        const one = stored(held);
        if (one !== null) {
          found.push(one);
        }
      }
      return found;
    },

    oldest() {
      return stored(ring.oldest());
    },

    newest() {
      return stored(ring.newest());
    },

    trim(mediaSeconds) {
      ring.trim(mediaSeconds);
    },

    clear() {
      ring.clear();
    },
  };
}
