import type { CachedEntry } from './entry.ts';

/**
 * The small metadata store the cache writes through.
 *
 * Kept apart from the Chrome implementation so that the store and its tests
 * never need the `chrome` namespace in their program: the Node test project
 * type-checks everything the tests import, and it deliberately has no
 * extension globals.
 */
export interface CacheMetadata {
  /** Whatever is under the key, or null when it has never been written. */
  read(): Promise<unknown>;
  write(entries: readonly CachedEntry[]): Promise<void>;
}
