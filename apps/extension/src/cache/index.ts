import { createOpusStemCodec } from './codec.ts';
import type { PracticeNote } from '../audio/practice.ts';
import type { SongFacts } from '../audio/song-analysis.ts';
import type {
  CachedDuet,
  CachedDuetInput,
  DuetExpectation,
} from './duet.ts';
import {
  createStemCache,
  type CacheEntryQuery,
  type CacheUsage,
  type StemCache,
  type StemWriter,
  type StemWriterOptions,
} from './store.ts';
import type { CachedEntry } from './entry.ts';
import { createOpfsCacheMetadata } from './metadata-opfs.ts';
import { createOpfsCacheFiles } from './opfs.ts';

/**
 * The cache as the rest of the extension sees it: four stems in, four stems
 * out, and a small set of answers about what is kept.
 *
 * The engine does not need to know about OPFS, Opus or the marker files. It
 * asks for the entry belonging to a video, and on a miss starts a writer and
 * feeds it blocks as they arrive. A hit comes back as float32 at the sample
 * rate it asked for.
 *
 * The metadata record is an OPFS JSON index rather than `chrome.storage.local`
 * because the engine runs in an offscreen document, where `chrome.storage` is
 * not there. The popup shares the extension origin and therefore the same
 * index, which is what lets it show usage and clear the cache.
 *
 * `cleanupInterruptedWrites` and `prune` are the one maintenance pass a new
 * session owes the cache: they remove a directory left behind by a crash, an
 * entry unused for the TTL, and a record whose files did not survive.
 */

let shared: StemCache | null = null;
let maintenance: Promise<void> | null = null;

/** The cache wired to the extension's own storage and codec. */
export function stemCache(): StemCache {
  shared ??= createStemCache({
    files: createOpfsCacheFiles(),
    metadata: createOpfsCacheMetadata(),
    codec: createOpusStemCodec(),
  });
  return shared;
}

/**
 * The maintenance pass, once per extension context.
 *
 * A failure leaves the cache usable for this session and is retried by the
 * next one rather than being remembered forever.
 */
export function prepareCache(): Promise<void> {
  if (maintenance === null) {
    maintenance = (async () => {
      const cache = stemCache();
      await cache.cleanupInterruptedWrites();
      await cache.prune();
    })().catch((cause: unknown) => {
      maintenance = null;
      throw cause;
    });
  }
  return maintenance;
}

export function hasCachedStems(key: string): Promise<boolean> {
  return stemCache().hasCachedStems(key);
}

export function cachedEntry(key: string) {
  return stemCache().cachedEntry(key);
}

export function findEntry(query: CacheEntryQuery) {
  return stemCache().findEntry(query);
}

export function createStemWriter(options: StemWriterOptions): Promise<StemWriter> {
  return stemCache().createStemWriter(options);
}

export function readCachedStems(key: string) {
  return stemCache().readCachedStems(key);
}

export function hasCachedDuet(
  key: string,
  expectation?: DuetExpectation,
): Promise<boolean> {
  return stemCache().hasCachedDuet(key, expectation);
}

export function readCachedDuet(
  key: string,
  expectation?: DuetExpectation,
): Promise<CachedDuet | null> {
  return stemCache().readCachedDuet(key, expectation);
}

export function writeCachedDuet(
  key: string,
  input: CachedDuetInput,
): Promise<CachedEntry> {
  return stemCache().writeCachedDuet(key, input);
}

export function removeCachedDuet(key: string): Promise<void> {
  return stemCache().removeCachedDuet(key);
}

export function touch(key: string): Promise<void> {
  return stemCache().touch(key);
}

export function markPlayed(key: string): Promise<void> {
  return stemCache().markPlayed(key);
}

export function saveAnalysis(key: string, facts: SongFacts): Promise<boolean> {
  return stemCache().saveAnalysis(key, facts);
}

export function savePracticeNotes(
  key: string,
  notes: readonly PracticeNote[],
): Promise<boolean> {
  return stemCache().savePracticeNotes(key, notes);
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

export function removeConflicts(
  query: CacheEntryQuery,
  keepKey: string,
): Promise<number> {
  return stemCache().removeConflicts(query, keepKey);
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
  CACHE_FORMAT_VERSION,
  CACHE_LIMIT_BYTES,
  CACHE_METADATA_VERSION,
  CACHE_TTL_MS,
  type CachedEntry,
  type CachedStems,
  type CachedStemChannels,
  type StereoChannels,
} from './entry.ts';
export {
  DUET_FORMAT_VERSION,
  MAX_DUET_MAP_BYTES,
  type CachedDuet,
  type CachedDuetInput,
  type CachedDuetMeta,
  type CachedDuetVoicePair,
  type DuetAnchor,
  type DuetExpectation,
  type DuetMap,
  type DuetQuality,
  type DuetSidecar,
  type DuetVoices,
} from './duet.ts';
export type { CacheMetadata } from './metadata-contract.ts';
export {
  CACHE_INDEX_DIRECTORY,
  CACHE_INDEX_FILE,
  CACHE_INDEX_TEMP,
  createIndexFileStore,
  createOpfsCacheMetadata,
  type CacheIndexFile,
  type IndexDirectory,
  type OpfsCacheMetadataOptions,
} from './metadata-opfs.ts';
export {
  cacheStatusLabel,
  formatBytes,
  normaliseCacheStatus,
  type CacheState,
  type CacheStatus,
} from './status.ts';
export {
  CacheError,
  type CacheEntryQuery,
  type StemCacheOptions,
  type StemWriterOptions,
} from './store.ts';
export type {
  CacheFiles,
  DuetFiles,
  DuetVoice,
  DuetWriter,
  EntryWriter,
} from './opfs.ts';
export type { MonoStemEncoder, StemCodec, StemEncoder } from './codec.ts';
export type { StemCache, StemWriter, CacheUsage };
