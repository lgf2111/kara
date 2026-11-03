/**
 * The per-pixel half of reading words off a video frame: turning RGBA into
 * grey, measuring how busy each row of a frame is, and preparing a crop so
 * OCR can read it.
 *
 * Pure array arithmetic, so it is tested on a handful of made-up pixels rather
 * than on a video. The canvas work that produces the arrays lives in
 * `frames.ts`.
 */

/** Rec. 601 luma, whose weights sum to exactly 1, so grey stays itself. */
function luma(red: number, green: number, blue: number): number {
  return Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
}

/** One byte of brightness per pixel, from an RGBA frame. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const gray = new Uint8Array(Math.floor(rgba.length / 4));
  for (let i = 0; i < gray.length; i += 1) {
    const at = i * 4;
    gray[i] = luma(rgba[at] ?? 0, rgba[at + 1] ?? 0, rgba[at + 2] ?? 0);
  }
  return gray;
}

/**
 * Mean absolute brightness change along each row.
 *
 * This is what finds the words. A row crossing a line of text steps between
 * stroke and background several times a character, which no amount of sky,
 * skin or gradient does, so a text row stands out even when its contrast is
 * low. Horizontal only, and per row: that is enough to say which band of the
 * frame the words live in, and it costs one pass over the pixels.
 */
export function rowEdgeEnergy(
  gray: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const energy = new Float32Array(Math.max(0, height));
  if (width < 2 || height < 1) {
    return energy;
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let total = 0;
    for (let x = 1; x < width; x += 1) {
      total += Math.abs((gray[row + x] ?? 0) - (gray[row + x - 1] ?? 0));
    }
    energy[y] = total / (width - 1);
  }
  return energy;
}

export interface PrepOptions {
  /** Brightness at this share of the pixels becomes black. */
  readonly lowShare: number;
  /** Brightness at this share of the pixels becomes white. */
  readonly highShare: number;
  /** Lyric videos are light text on a dark picture; tesseract wants the reverse. */
  readonly negate: boolean;
}

export const PREP: PrepOptions = { lowShare: 0.02, highShare: 0.98, negate: true };

/**
 * Prepares a crop for OCR, in place: grey, contrast stretched between two
 * percentiles, then inverted.
 *
 * The percentiles rather than the extremes, because one bright pixel of a
 * logo would otherwise set the white point and leave the words grey. A flat
 * crop has nothing to stretch, so it is only inverted.
 *
 * @param rgba the crop's pixels, overwritten with the prepared ones
 */
export function prepareForOcr(
  rgba: Uint8ClampedArray | Uint8Array,
  options: Partial<PrepOptions> = {},
): void {
  const settings = { ...PREP, ...options };
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) {
    return;
  }

  const gray = new Uint8Array(pixels);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    const value = luma(rgba[at] ?? 0, rgba[at + 1] ?? 0, rgba[at + 2] ?? 0);
    gray[i] = value;
    histogram[value] = (histogram[value] ?? 0) + 1;
  }

  const brightnessAt = (share: number): number => {
    const wanted = Math.max(1, share * pixels);
    let seen = 0;
    for (let value = 0; value < 256; value += 1) {
      seen += histogram[value] ?? 0;
      if (seen >= wanted) {
        return value;
      }
    }
    return 255;
  };
  const low = brightnessAt(settings.lowShare);
  const high = brightnessAt(settings.highShare);
  const span = high - low;

  for (let i = 0; i < pixels; i += 1) {
    const value = gray[i] ?? 0;
    const stretched = span > 0 ? Math.round(((value - low) * 255) / span) : value;
    const clamped = Math.max(0, Math.min(255, stretched));
    const out = settings.negate ? 255 - clamped : clamped;
    const at = i * 4;
    rgba[at] = out;
    rgba[at + 1] = out;
    rgba[at + 2] = out;
    rgba[at + 3] = 255;
  }
}
