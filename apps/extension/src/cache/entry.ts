import type { PracticeNote } from '../audio/practice.ts';
import type { SongFacts } from '../audio/song-analysis.ts';
import { normalisePracticeNotes } from '../audio/practice.ts';
import { normaliseSongFacts } from '../audio/song-analysis.ts';
import type { Stem } from '../audio/stems.ts';
import {
  normaliseCachedDuetMeta,
  type CachedDuetMeta,
} from './duet.ts';

export { DUET_FORMAT_VERSION } from './duet.ts';

/**
 * What a cached stem set is, and the small record that remembers it.
 *
 * The bytes live in OPFS under `kara-cache/`; this file knows only the shape of
 * an entry, the key that names it and the parsing that keeps a corrupted store
 * from turning into a broken session. It has no browser API in it, so the
 * arithmetic and the rejection rules can be tested in Node.
 *
 * A key carries every input that can change the audio: the video, the file
 * format, the separation model, the sample rate and the frame count. A new
 * model or a new format therefore cannot find an old entry by accident. The
 * directory name is a hash of the key, so a long title or a version with a
 * slash never becomes a path.
 */

/** The default self-imposed limit. Chrome's OPFS quota is much larger. */
export const CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;

/**
 * The most one video may take. A 128 kbps stereo stem costs about 16 KB/s, so
 * four stems are about 64 KB/s and this is roughly an hour and a quarter.
 * Without this a single very long video could fill the whole cache and make
 * every other song miss.
 */
export const CACHE_ENTRY_LIMIT_BYTES = 256 * 1024 * 1024;

/** Entries unused for this long are removed by `prune`. */
export const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The version inside the metadata blob, separate from the audio format. */
export const CACHE_METADATA_VERSION = 2;

/**
 * The entry format this build writes.
 *
 * It is part of the key, so an entry written by an older layout — one without
 * the cached song facts or practice notes — can never be mistaken for one this
 * engine understands. Bump it whenever the meaning of an entry changes.
 */
export const CACHE_FORMAT_VERSION = 2;

/** A pathological note list must not turn into a megabyte of metadata. */
export const MAX_CACHED_PRACTICE_NOTES = 20_000;

export const MAX_CACHE_TITLE_LENGTH = 160;
export const MAX_CACHE_ARTIST_LENGTH = 120;
export const MAX_CACHE_VIDEO_ID_LENGTH = 64;
export const MAX_CACHE_MODEL_VERSION_LENGTH = 80;

/** One complete set of four stems, as the cache remembers it. */
export interface CachedEntry {
  readonly key: string;
  readonly videoId: string;
  readonly title: string;
  readonly artist: string;
  readonly durationFrames: number;
  readonly sampleRate: number;
  readonly modelVersion: string;
  readonly formatVersion: number;
  readonly bytes: number;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds; `touch` and `markPlayed` move this forward. */
  readonly lastUsedAt: number;
  readonly playCount: number;
  /** Always true for an entry the cache exposes. */
  readonly complete: boolean;
  /**
   * The Song card's facts, when they were cached after the analysis ran.
   * Absent means the entry has none yet, which is a reason to analyse the
   * cached stems rather than to show nothing.
   */
  readonly analysis?: SongFacts | null;
  /**
   * The guide melody learnt from the cached vocal stem. An empty array is a
   * real answer — the analysis ran and found nothing — while absent means it
   * has not run yet.
   */
  readonly practiceNotes?: readonly PracticeNote[] | null;
  /**
   * The optional Duet sidecar. It is independent of the stems and its own
   * version: a missing or outdated duet never makes the stems a miss.
   */
  readonly duet?: CachedDuetMeta | null;
}

/** Four stereo channels in the model's order, which is the player's order. */
export type CachedStemChannels = Readonly<Record<Stem, StereoChannels>>;

export interface StereoChannels {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

export interface CachedStems {
  readonly key: string;
  readonly sampleRate: number;
  readonly frames: number;
  readonly stems: CachedStemChannels;
}

/**
 * The name of one cache entry.
 *
 * Slashes are escaped rather than trusted, so a model version or a future
 * source id cannot change the shape of the key. The result is a string for
 * metadata and logs; the OPFS layer hashes it before using it as a directory.
 */
export function cacheKey(
  videoId: string,
  formatVersion: number,
  modelVersion: string,
  sampleRate: number,
  frames: number,
): string {
  const parts = [
    videoId,
    String(formatVersion),
    modelVersion,
    String(sampleRate),
    String(frames),
  ].map((part) => encodeURIComponent(part));
  return `kara.stems/${parts.join('/')}`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number);
}

/** A single-line, trimmed string, bounded so a title cannot grow storage. */
function textOf(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/gu, ' ').trim().slice(0, limit).trim();
}

/** Epoch milliseconds from a number or an ISO date, or null when unreadable. */
function timeOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function validSampleRate(value: number | null): value is number {
  return value !== null && value >= 8000 && value <= 384000;
}

/**
 * One entry out of whatever storage had, or null when it cannot be trusted.
 *
 * Everything that decides which audio an entry holds is checked against the
 * key: a record whose fields do not hash back to its key is a record from a
 * version whose meaning has changed, and playing it would put the wrong stems
 * under the video. Titles and artists are cosmetic, so they are trimmed and
 * bounded rather than used as a reason to drop the audio.
 */
export function normaliseCachedEntry(raw: unknown): CachedEntry | null {
  const stored = recordOf(raw);
  const key = typeof stored['key'] === 'string' ? stored['key'] : '';
  const videoId = textOf(stored['videoId'], MAX_CACHE_VIDEO_ID_LENGTH);
  const modelVersion = textOf(
    stored['modelVersion'],
    MAX_CACHE_MODEL_VERSION_LENGTH,
  );
  const formatVersion = integerOrNull(stored['formatVersion']);
  const sampleRate = integerOrNull(stored['sampleRate']);
  const durationFrames = integerOrNull(stored['durationFrames']);
  const bytes = integerOrNull(stored['bytes']);
  const playCount = integerOrNull(stored['playCount']);
  const createdAt = timeOrNull(stored['createdAt']);
  const lastUsedAt = timeOrNull(stored['lastUsedAt']);

  if (
    stored['complete'] !== true ||
    key === '' ||
    videoId === '' ||
    modelVersion === '' ||
    formatVersion === null ||
    formatVersion < 0 ||
    !validSampleRate(sampleRate) ||
    durationFrames === null ||
    durationFrames <= 0 ||
    bytes === null ||
    bytes <= 0 ||
    playCount === null ||
    playCount < 0 ||
    (createdAt === null && lastUsedAt === null)
  ) {
    return null;
  }

  // One timestamp is enough to recover an entry written by an older record;
  // both missing is not a record worth guessing about.
  const created = createdAt ?? lastUsedAt ?? 0;
  const used = lastUsedAt ?? createdAt ?? 0;
  if (key !== cacheKey(videoId, formatVersion, modelVersion, sampleRate, durationFrames)) {
    return null;
  }

  // The cached analysis and notes are conveniences: a malformed one is
  // dropped rather than the whole entry, because the stems are still good and
  // the engine can analyse them again.
  const storedAnalysis = stored['analysis'];
  const analysis =
    typeof storedAnalysis === 'object' &&
    storedAnalysis !== null &&
    !Array.isArray(storedAnalysis)
      ? normaliseSongFacts(storedAnalysis)
      : null;
  const storedNotes = stored['practiceNotes'];
  const notes = Array.isArray(storedNotes)
    ? normalisePracticeNotes(storedNotes)
    : null;
  const practiceNotes =
    notes !== null && notes.length <= MAX_CACHED_PRACTICE_NOTES ? notes : null;

  // The duet is a second layer inside the same record. A malformed one is
  // dropped while the stems stay usable; a duet cannot be the whole entry, so
  // it must account for less than the total bytes.
  const duet = normaliseCachedDuetMeta(stored['duet'], {
    frames: durationFrames,
    sampleRate,
  });
  const validDuet = duet !== undefined && duet.bytes < bytes ? duet : undefined;

  return {
    key,
    videoId,
    title: textOf(stored['title'], MAX_CACHE_TITLE_LENGTH),
    artist: textOf(stored['artist'], MAX_CACHE_ARTIST_LENGTH),
    durationFrames,
    sampleRate,
    modelVersion,
    formatVersion,
    bytes,
    createdAt: created,
    lastUsedAt: used,
    playCount,
    complete: true,
    ...(analysis === null ? {} : { analysis }),
    ...(practiceNotes === null ? {} : { practiceNotes }),
    ...(validDuet === undefined ? {} : { duet: validDuet }),
  };
}

/**
 * The entries out of the metadata blob, with malformed records dropped.
 *
 * A plain array is accepted as well as the versioned object: the key is
 * versioned too, but accepting the older shape costs nothing and lets a write
 * from a half-finished migration be read rather than thrown away. Duplicate
 * keys keep the record that was used most recently, which is the one a read
 * would have touched.
 */
export function normaliseCacheMetadata(raw: unknown): CachedEntry[] {
  const entries: unknown = Array.isArray(raw)
    ? raw
    : (() => {
        const stored = recordOf(raw);
        return stored['version'] === CACHE_METADATA_VERSION
          ? stored['entries']
          : null;
      })();
  if (!Array.isArray(entries)) {
    return [];
  }

  const byKey = new Map<string, CachedEntry>();
  for (const item of entries) {
    const entry = normaliseCachedEntry(item);
    if (entry === null) {
      continue;
    }
    const current = byKey.get(entry.key);
    if (
      current === undefined ||
      entry.lastUsedAt > current.lastUsedAt ||
      (entry.lastUsedAt === current.lastUsedAt && entry.playCount > current.playCount)
    ) {
      byKey.set(entry.key, entry);
    }
  }
  return [...byKey.values()];
}

/** Least-played first, then oldest use, then the key for a stable tie. */
export function compareForEviction(left: CachedEntry, right: CachedEntry): number {
  if (left.playCount !== right.playCount) {
    return left.playCount - right.playCount;
  }
  if (left.lastUsedAt !== right.lastUsedAt) {
    return left.lastUsedAt - right.lastUsedAt;
  }
  return left.key.localeCompare(right.key);
}

/** Newest use first, with the key breaking ties for a stable list. */
export function compareForListing(left: CachedEntry, right: CachedEntry): number {
  if (left.lastUsedAt !== right.lastUsedAt) {
    return right.lastUsedAt - left.lastUsedAt;
  }
  return left.key.localeCompare(right.key);
}
