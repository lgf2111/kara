import { describe, expect, it } from 'vitest';

import {
  byteRanges,
  DOWNLOAD_CHUNK_BYTES,
  parseContentLength,
  parseContentRange,
} from '../src/audio/download.ts';

describe('byteRanges', () => {
  it('tiles the whole file once, in order, with no gap and no overlap', () => {
    const ranges = byteRanges(2_500_000, 1_000_000);

    expect(ranges).toEqual([
      { start: 0, end: 999_999 },
      { start: 1_000_000, end: 1_999_999 },
      { start: 2_000_000, end: 2_499_999 },
    ]);
  });

  it('ends the last range short rather than reading past the file', () => {
    const ranges = byteRanges(10, 4);

    expect(ranges.at(-1)).toEqual({ start: 8, end: 9 });
  });

  it('asks for a whole small file in one range', () => {
    expect(byteRanges(5)).toEqual([{ start: 0, end: 4 }]);
  });

  it('has nothing to ask for when there is no file', () => {
    expect(byteRanges(0)).toEqual([]);
    expect(byteRanges(-1)).toEqual([]);
    expect(byteRanges(Number.NaN)).toEqual([]);
  });

  it('falls back to the usual chunk size rather than trusting a bad one', () => {
    expect(byteRanges(DOWNLOAD_CHUNK_BYTES + 1, Number.NaN)).toEqual([
      { start: 0, end: DOWNLOAD_CHUNK_BYTES - 1 },
      { start: DOWNLOAD_CHUNK_BYTES, end: DOWNLOAD_CHUNK_BYTES },
    ]);
  });
});

describe('parseContentRange', () => {
  it('reads the start, end and whole length out of a normal header', () => {
    expect(parseContentRange('bytes 983040-1966079/3433755')).toEqual({
      start: 983040,
      end: 1966079,
      total: 3433755,
    });
  });

  it('accepts an unknown total, since the range is still usable', () => {
    expect(parseContentRange('bytes 0-65535/*')).toEqual({
      start: 0,
      end: 65535,
      total: null,
    });
  });

  it('refuses a range that ends before it starts', () => {
    expect(parseContentRange('bytes 200-100/1000')).toBeNull();
  });

  it('refuses an end beyond the length it claims', () => {
    expect(parseContentRange('bytes 0-2000/1000')).toBeNull();
  });

  it('refuses anything that is not a byte range', () => {
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange('')).toBeNull();
    expect(parseContentRange('items 0-10/20')).toBeNull();
    expect(parseContentRange('bytes 0-10')).toBeNull();
  });
});

describe('parseContentLength', () => {
  it('reads a positive length', () => {
    expect(parseContentLength('3433755')).toBe(3433755);
  });

  it('treats a missing, zero or negative length as unknown', () => {
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('0')).toBeNull();
    expect(parseContentLength('-5')).toBeNull();
    expect(parseContentLength('not a number')).toBeNull();
  });
});
