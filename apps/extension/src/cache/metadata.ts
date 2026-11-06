import {
  CACHE_METADATA_VERSION,
  type CachedEntry,
} from './entry.ts';
import type { CacheMetadata } from './metadata-contract.ts';

export type { CacheMetadata } from './metadata-contract.ts';

/**
 * Where the small record of each entry lives: `chrome.storage.local`, one
 * versioned key, no audio. A failure here is reported to the store, which
 * decides whether a read should look empty or a write should fail; this file
 * only knows how to talk to Chrome.
 */

export const CACHE_METADATA_KEY = 'kara.cache.stems.v1';

function metadataDocument(entries: readonly CachedEntry[]): {
  readonly version: number;
  readonly entries: readonly CachedEntry[];
} {
  return { version: CACHE_METADATA_VERSION, entries };
}

export function createChromeCacheMetadata(): CacheMetadata {
  return {
    async read() {
      const stored = await chrome.storage.local.get(CACHE_METADATA_KEY);
      return stored[CACHE_METADATA_KEY] ?? null;
    },
    async write(entries) {
      await chrome.storage.local.set({
        [CACHE_METADATA_KEY]: metadataDocument(entries),
      });
    },
  };
}
