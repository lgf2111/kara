import type { StoredFrame } from './frame-store.ts';

/**
 * Turning the page's video into something cheap to keep, and back again just
 * before it is shown.
 *
 * Both halves exist for the same reason, which is that the GPU this extension
 * runs the model on is the GPU the page decodes its video on. Holding eighteen
 * seconds of decoded frames took about 250 MB of GPU-backed `ImageBitmap`s and
 * made YouTube's own playback crawl, which starved the capture, which starved
 * the separator. So:
 *
 * - **keeping** is `OffscreenCanvas.convertToBlob` at about 640 px wide and
 *   quality 0.6, which is a webp of a few tens of kilobytes in ordinary heap
 *   memory. The canvas is one canvas, reused, and only one encode is ever in
 *   flight: a page that cannot keep up with fifteen a second should keep
 *   fewer frames, not queue them.
 * - **showing** is `createImageBitmap` on the blob about to be painted, plus a
 *   small look-ahead so the painter is never waiting on a decode. A handful of
 *   bitmaps exist at a time and every one of them is closed by hand, because
 *   that is the memory the old design let accumulate.
 *
 * Nothing here decides what to keep or what to show. `delayed-picture.ts`
 * does that; this file is the two conversions and the ceiling on each.
 */

/** Frames are kept at this width, which is what the budget is reckoned on. */
export const KEPT_WIDTH = 640;

/** Webp at about this quality: a readable face, a few tens of kilobytes. */
export const KEPT_QUALITY = 0.6;

/**
 * Webp rather than jpeg: a little smaller at the same quality and alpha-safe,
 * and every Chromium this extension can run on encodes it.
 */
export const KEPT_TYPE = 'image/webp';

/** Decoded frames held at once. Enough for the look-ahead and no more. */
export const DECODED_LIMIT = 8;

/** How far ahead of the painted frame to decode, in seconds of song. */
export const LOOK_AHEAD_SECONDS = 0.5;

export interface FrameCodecOptions {
  readonly maxWidth?: number;
  readonly quality?: number;
  readonly type?: string;
  readonly decodedLimit?: number;
}

export interface FrameCodec {
  /** Encodes in flight. One at most, so a slow machine keeps fewer frames. */
  readonly encoding: number;
  readonly decoded: number;
  /**
   * Compresses what the video is showing now, or null when it cannot: no
   * dimensions yet, an encode already in flight, or no `OffscreenCanvas`.
   */
  keep(video: HTMLVideoElement): Promise<Blob | null> | null;
  /** The decoded frame, if it has been decoded. Null starts one. */
  bitmapFor(frame: StoredFrame<Blob>): ImageBitmap | null;
  /** Gets ahead of the painter, so a frame is ready when its moment comes. */
  prefetch(frames: readonly StoredFrame<Blob>[]): void;
  clear(): void;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createFrameCodec(options: FrameCodecOptions = {}): FrameCodec {
  const maxWidth = positive(options.maxWidth, KEPT_WIDTH);
  const quality = positive(options.quality, KEPT_QUALITY);
  const type = options.type ?? KEPT_TYPE;
  const limit = Math.max(1, Math.round(positive(options.decodedLimit, DECODED_LIMIT)));

  let canvas: OffscreenCanvas | null = null;
  let brush: OffscreenCanvasRenderingContext2D | null = null;
  let encoding = 0;
  /** Keyed by the frame's media time, which is what the painter asks by. */
  const bitmaps = new Map<number, ImageBitmap>();
  const decoding = new Set<number>();

  const room = (width: number, height: number): OffscreenCanvasRenderingContext2D | null => {
    if (typeof OffscreenCanvas === 'undefined') {
      return null;
    }
    if (canvas === null || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      brush = canvas.getContext('2d', { alpha: false });
    }
    return brush;
  };

  /** The oldest decoded frames, closed, down to the ceiling. */
  const shed = (): void => {
    while (bitmaps.size > limit) {
      const oldest = bitmaps.keys().next();
      if (oldest.done === true) {
        return;
      }
      bitmaps.get(oldest.value)?.close();
      bitmaps.delete(oldest.value);
    }
  };

  const decode = (frame: StoredFrame<Blob>): void => {
    const key = frame.mediaSeconds;
    if (bitmaps.has(key) || decoding.has(key)) {
      return;
    }
    decoding.add(key);
    createImageBitmap(frame.data)
      .then((bitmap) => {
        decoding.delete(key);
        if (bitmaps.has(key)) {
          bitmap.close();
          return;
        }
        bitmaps.set(key, bitmap);
        shed();
      })
      .catch(() => {
        // One frame that would not decode is one frame. The next one will.
        decoding.delete(key);
      });
  };

  return {
    get encoding() {
      return encoding;
    },
    get decoded() {
      return bitmaps.size;
    },

    keep(video) {
      if (encoding > 0) {
        return null;
      }
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width === 0 || height === 0) {
        return null;
      }
      const scale = Math.min(1, maxWidth / width);
      const kept = {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      };
      const target = room(kept.width, kept.height);
      if (target === null || canvas === null) {
        return null;
      }
      encoding += 1;
      target.drawImage(video, 0, 0, kept.width, kept.height);
      return canvas
        .convertToBlob({ type, quality })
        .then((blob) => {
          encoding -= 1;
          return blob;
        })
        .catch(() => {
          encoding -= 1;
          return null;
        });
    },

    bitmapFor(frame) {
      const found = bitmaps.get(frame.mediaSeconds);
      if (found !== undefined) {
        return found;
      }
      decode(frame);
      return null;
    },

    prefetch(frames) {
      for (const frame of frames) {
        decode(frame);
      }
    },

    clear() {
      for (const bitmap of bitmaps.values()) {
        bitmap.close();
      }
      bitmaps.clear();
      decoding.clear();
      canvas = null;
      brush = null;
    },
  };
}
