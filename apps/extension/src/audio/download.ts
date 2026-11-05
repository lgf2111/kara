/**
 * The arithmetic of reading a file with range requests.
 *
 * A YouTube media URL is signed for a time and an address, and the server is
 * entitled to end a connection whenever it likes. In practice a single GET for
 * a whole track is cut off partway, while a series of bounded ranges is not,
 * so the track is read in chunks. This file decides what those chunks are and
 * reads the one header the server sends back about them; the fetching lives in
 * `offscreen/engine.ts`, where the progress report is.
 *
 * Pure, so the boundaries are the test.
 */

/** About a megabyte: small enough to finish, large enough not to chatter. */
export const DOWNLOAD_CHUNK_BYTES = 960 * 1024;

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The ranges that tile `total` bytes exactly once, in order.
 *
 * The last range is short when the total is not a multiple of the chunk size,
 * and an empty total has no ranges at all.
 */
export function byteRanges(total: number, size = DOWNLOAD_CHUNK_BYTES): ByteRange[] {
  const whole = Number.isFinite(total) ? Math.floor(total) : 0;
  const step = Number.isFinite(size) && size >= 1 ? Math.floor(size) : DOWNLOAD_CHUNK_BYTES;
  if (whole <= 0) {
    return [];
  }
  const ranges: ByteRange[] = [];
  for (let start = 0; start < whole; start += step) {
    ranges.push({ start, end: Math.min(whole - 1, start + step - 1) });
  }
  return ranges;
}

export interface ContentRange {
  readonly start: number;
  readonly end: number;
  /** The whole file's length, or null when the server wrote `*`. */
  readonly total: number | null;
}

/**
 * What a `Content-Range` header says, or null if it is not one this code
 * understands.
 *
 * A 206 response writes `bytes 0-65535/3433755`. The total is the part worth
 * having: it turns "some bytes arrived" into a length the whole file can be
 * allocated from.
 */
export function parseContentRange(header: string | null): ContentRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(header ?? '');
  if (match === null) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  if (match[3] === '*') {
    return { start, end, total: null };
  }
  const total = Number(match[3]);
  // The range must fit inside the length it claims. A header where it does
  // not cannot be used to decide what to ask for next.
  if (!Number.isFinite(total) || total <= end) {
    return null;
  }
  return { start, end, total };
}

/** A positive Content-Length, or null for a header that is absent or useless. */
export function parseContentLength(header: string | null): number | null {
  const length = Number(header);
  return Number.isFinite(length) && length > 0 ? length : null;
}
