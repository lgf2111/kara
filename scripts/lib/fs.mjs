import { readFileSync, statSync } from 'node:fs';

/** Bytes inspected when deciding whether a file is binary. */
const SNIFF_BYTES = 8192;

/**
 * A NUL byte near the start means the file is not text. Good enough for a repo
 * guard, and the media guard owns binaries anyway.
 *
 * @param {Uint8Array} contents
 * @returns {boolean}
 */
export function looksBinary(contents) {
  return contents.subarray(0, SNIFF_BYTES).includes(0);
}

/**
 * Size on disk, or null when the path is tracked but absent, as in a sparse
 * checkout.
 *
 * @param {string} filePath
 * @returns {number | null}
 */
export function sizeOf(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * File contents as text, or null when the file is missing, binary or larger
 * than the cap.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string | null}
 */
export function readTextFile(filePath, maxBytes) {
  /** @type {Buffer} */
  let contents;
  try {
    contents = readFileSync(filePath);
  } catch {
    return null;
  }
  if (contents.length > maxBytes || looksBinary(contents)) {
    return null;
  }
  return contents.toString('utf8');
}
