/**
 * Which screen the address bar asks for. The hash is the whole router: no
 * dependency, no server rewrite, and reloading the page lands back on the
 * same song.
 */

const PLAY_PREFIX = '#/play/';

export function playerHashFor(songId: string): string {
  return `${PLAY_PREFIX}${encodeURIComponent(songId)}`;
}

/** The library, which is where the back button goes. */
export const LIBRARY_HASH = '#/';

/** The song the hash names, or null for the library. */
export function songIdFromHash(hash: string): string | null {
  if (!hash.startsWith(PLAY_PREFIX)) {
    return null;
  }
  const raw = hash.slice(PLAY_PREFIX.length);
  if (raw === '') {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    // A half-typed escape in the address bar is not a song.
    return null;
  }
}
