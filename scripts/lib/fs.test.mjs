import { describe, expect, it } from 'vitest';

import { looksBinary, readTextFile, sizeOf } from './fs.mjs';

describe('looksBinary', () => {
  it('spots a NUL byte', () => {
    expect(looksBinary(Uint8Array.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('accepts text, including UTF-8 beyond ASCII', () => {
    expect(looksBinary(new TextEncoder().encode('一首歌 / a song\n'))).toBe(false);
    expect(looksBinary(Uint8Array.from([]))).toBe(false);
  });
});

describe('sizeOf', () => {
  it('measures a file that exists', () => {
    expect(sizeOf('package.json')).toBeGreaterThan(0);
  });

  it('returns null for a path that does not', () => {
    expect(sizeOf('no/such/file')).toBeNull();
  });
});

describe('readTextFile', () => {
  it('reads text within the cap', () => {
    expect(readTextFile('package.json', 1024 * 1024)).toContain('"name": "kara"');
  });

  it('returns null past the cap', () => {
    expect(readTextFile('package.json', 4)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(readTextFile('no/such/file', 1024)).toBeNull();
  });
});
