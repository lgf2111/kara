import { createOpusStemCodec } from './codec.ts';
import type { StemWriterOptions } from './store.ts';
import { createStemCache, type CacheUsage, type StemCache, type StemWriter } from './store.ts';
import { createChromeCacheMetadata } from './metadata.ts';
import { createOpfsCacheFiles } from './opfs.ts';

/**
 * The cache as the rest of the extension sees it: four stems in, four stems
 * out, and a small set of answers about what is kept.
 *
 * The engine does not need to know about OPFS, `chrome.storage`, Opus or the
 * marker files. It computes a key from the project it is about to separate,
 * asks `hasCachedStems`, and on a miss starts a writer and feeds it blocks as
 * they arrive. A hit comes back as float32 at the sample rate it asked for.
 *
 * `cleanupInterruptedWrites` is the one call a new session owes the cache: it
 * removes a directory left behind by a crash, and a record whose files did
 * not survive.
 */

let shared: StemCache | null = null;

/** The cache wired to the extension's own storage and codec. */
export function stemCache(): StemCache {
  shared ??= createStemCache({
    files: createOpfsCacheFiles(),
    metadata: createChromeCacheMetadata(),
    codec: createOpusStemCodec(),
  });
  return shared;
}

export function hasCachedStems(key: string): Promise<boolean> {
  return stemCache().hasCachedStems(key);
}

export function cachedEntry(key: string) {
  return stemCache().cachedEntry(key);
}

export function createStemWriter(options: StemWriterOptions): Promise<StemWriter> {
  return stemCache().createStemWriter(options);
}

export function readCachedStems(key: string) {
  return stemCache().readCachedStems(key);
}

export function touch(key: string): Promise<void> {
  return stemCache().touch(key);
}

export function markPlayed(key: string): Promise<void> {
  return stemCache().markPlayed(key);
}

export function listEntries() {
  return stemCache().listEntries();
}

export function usage(): Promise<CacheUsage> {
  return stemCache().usage();
}

export function evictUntilUnder(
  limitBytes: number,
  protectedKey?: string,
): Promise<number> {
  return stemCache().evictUntilUnder(limitBytes, protectedKey);
}

export function clearCache(): Promise<void> {
  return stemCache().clearCache();
}

export function removeEntry(key: string): Promise<void> {
  return stemCache().removeEntry(key);
}

export function prune(now?: number): Promise<number> {
  return stemCache().prune(now);
}

export function cleanupInterruptedWrites(): Promise<number> {
  return stemCache().cleanupInterruptedWrites();
}

export { cacheKey } from './entry.ts';
export {
  CACHE_ENTRY_LIMIT_BYTES,
  CACHE_LIMIT_BYTES,
  CACHE_TTL_MS,
  type CachedEntry,
  type CachedStems,
  type CachedStemChannels,
  type StereoChannels,
} from './entry.ts';
export { CacheError, type StemCacheOptions, type StemWriterOptions } from './store.ts';
export type { CacheFiles, EntryWriter } from './opfs.ts';
export type { CacheMetadata } from './metadata-contract.ts';
export type { StemCodec, StemEncoder } from './codec.ts';
export type { StemCache, StemWriter, CacheUsage };
