import { STEMS, isStem, type Stem } from '../audio/stems.ts';
import { normalisePracticeNotes, type PracticeNote } from '../audio/practice.ts';
import { normaliseSongFacts, type SongFacts } from '../audio/song-analysis.ts';
import {
  CACHE_ENTRY_LIMIT_BYTES,
  CACHE_LIMIT_BYTES,
  CACHE_TTL_MS,
  MAX_CACHE_ARTIST_LENGTH,
  MAX_CACHE_TITLE_LENGTH,
  MAX_CACHED_PRACTICE_NOTES,
  cacheKey,
  compareForEviction,
  compareForListing,
  normaliseCacheMetadata,
  type CachedEntry,
  type CachedStems,
  type StereoChannels,
} from './entry.ts';
import type { CodecInput, StemCodec, StemEncoder } from './codec.ts';
import type { CacheFiles, EntryWriter } from './opfs.ts';
import type { CacheMetadata } from './metadata-contract.ts';

/**
 * The cache's state machine: one writer, a metadata list and a cap.
 *
 * The bytes are in OPFS and the records are in `chrome.storage.local`; this
 * class is both halves in the order that keeps a crash from leaving a
 * half-written song looking playable. A writer only touches the filesystem on
 * `finish`, after every stem has encoded successfully, and only writes the
 * metadata record after the complete marker is on disk. Anything interrupted
 * before that is a directory with no complete marker, which `cleanup` removes.
 *
 * Every metadata mutation goes through one promise chain. Reads decode
 * outside it; touches and evictions queue, so two loads finishing together
 * cannot lose a play count or overwrite each other's list.
 */

/** The metadata a stem file begins with, private to this format. */
const FILE_MAGIC = [0x4b, 0x53, 0x43, 0x31] as const;
const FILE_VERSION = 1;
const FILE_CHANNELS = 2;
const HEADER_BASE_BYTES = 25;
const MAX_CODEC_ID_BYTES = 255;

/**
 * On a quota error the metadata may say the entry fits while the filesystem
 * disagrees. Free this much more than the new entry needs before retrying,
 * rather than asking for the same target that just failed.
 */
const QUOTA_RETRY_HEADROOM_BYTES = 64 * 1024 * 1024;

export class CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheError';
  }
}

export interface StemWriterOptions {
  readonly key: string;
  readonly videoId: string;
  readonly title: string;
  readonly artist: string;
  readonly durationFrames: number;
  readonly sampleRate: number;
  readonly modelVersion: string;
  readonly formatVersion: number;
  /** Defaults to the store's per-entry cap. Never exceeds it. */
  readonly maxBytes?: number;
}

export interface StemWriter {
  /**
   * Feeds one contiguous block of one stem. Blocks may interleave between
   * stems, but each stem's blocks must start where its previous one ended.
   */
  append(
    stem: Stem,
    startSample: number,
    left: Float32Array,
    right: Float32Array,
  ): Promise<void>;
  finish(): Promise<CachedEntry>;
  abort(): Promise<void>;
}

export interface CacheUsage {
  readonly bytes: number;
  readonly count: number;
  readonly limitBytes: number;
}

/**
 * Everything the engine knows before it reads the stream, except the frame
 * count that is only known after decoding. The lookup therefore returns null
 * when more than one entry matches: two frame counts for one video are two
 * different files, and picking one would be a guess.
 */
export interface CacheEntryQuery {
  readonly videoId: string;
  readonly modelVersion: string;
  readonly formatVersion: number;
  readonly sampleRate: number;
}

export interface StemCacheOptions {
  readonly files: CacheFiles;
  readonly metadata: CacheMetadata;
  readonly codec: StemCodec;
  readonly limitBytes?: number;
  readonly maxEntryBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface StemFileHeader {
  readonly sampleRate: number;
  readonly frames: number;
  readonly codecRate: number;
  readonly delayFrames: number;
  readonly codecId: string;
}

interface ParsedStemFile {
  readonly header: StemFileHeader;
  readonly packets: readonly Uint8Array[];
}

interface HeaderInput {
  readonly sampleRate: number;
  readonly frames: number;
  readonly codecRate: number;
  readonly delayFrames: number;
  readonly codecId: string;
}

function clampBytes(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function isInteger(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min;
}

function isQuotaExceeded(error: unknown): boolean {
  if (error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    );
  }
  const record =
    typeof error === 'object' && error !== null
      ? (error as { readonly name?: unknown; readonly code?: unknown })
      : {};
  return (
    record['name'] === 'QuotaExceededError' ||
    record['code'] === 22 ||
    record['code'] === 1014
  );
}

function encodeHeader(input: HeaderInput): Uint8Array<ArrayBuffer> {
  const codecId = new TextEncoder().encode(input.codecId);
  const bytes = new Uint8Array(HEADER_BASE_BYTES + codecId.length);
  const view = new DataView(bytes.buffer);
  bytes.set(FILE_MAGIC, 0);
  view.setUint8(4, FILE_VERSION);
  view.setUint8(5, FILE_CHANNELS);
  view.setUint16(6, 0, true);
  view.setUint32(8, input.sampleRate, true);
  view.setUint32(12, input.frames, true);
  view.setUint32(16, input.codecRate, true);
  view.setUint32(20, input.delayFrames, true);
  view.setUint8(24, codecId.length);
  bytes.set(codecId, HEADER_BASE_BYTES);
  return bytes;
}

function parseStemFile(bytes: Uint8Array): ParsedStemFile | null {
  if (bytes.byteLength < HEADER_BASE_BYTES) {
    return null;
  }
  for (const [index, value] of FILE_MAGIC.entries()) {
    if (bytes[index] !== value) {
      return null;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== FILE_VERSION || view.getUint8(5) !== FILE_CHANNELS) {
    return null;
  }
  const codecIdLength = view.getUint8(24);
  if (codecIdLength > MAX_CODEC_ID_BYTES) {
    return null;
  }
  const headerBytes = HEADER_BASE_BYTES + codecIdLength;
  if (headerBytes > bytes.byteLength) {
    return null;
  }
  const header: StemFileHeader = {
    sampleRate: view.getUint32(8, true),
    frames: view.getUint32(12, true),
    codecRate: view.getUint32(16, true),
    delayFrames: view.getUint32(20, true),
    codecId: new TextDecoder().decode(bytes.subarray(HEADER_BASE_BYTES, headerBytes)),
  };
  const packets: Uint8Array[] = [];
  let offset = headerBytes;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) {
      return null;
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length === 0 || offset + length > bytes.byteLength) {
      return null;
    }
    packets.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return packets.length === 0 ? null : { header, packets };
}

function framedBytes(header: Uint8Array, packets: readonly Uint8Array[]): number {
  let total = header.byteLength;
  for (const packet of packets) {
    total += 4 + packet.byteLength;
  }
  return total;
}

function buildStemFile(
  header: Uint8Array<ArrayBuffer>,
  packets: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(framedBytes(header, packets));
  const view = new DataView(bytes.buffer);
  bytes.set(header, 0);
  let offset = header.byteLength;
  for (const packet of packets) {
    view.setUint32(offset, packet.byteLength, true);
    offset += 4;
    bytes.set(packet, offset);
    offset += packet.byteLength;
  }
  return bytes;
}

function totalBytes(entries: readonly CachedEntry[]): number {
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
  }
  return bytes;
}

export class StemCache {
  private readonly files: CacheFiles;
  private readonly metadata: CacheMetadata;
  private readonly codec: StemCodec;
  private readonly now: () => number;
  readonly limitBytes: number;
  readonly maxEntryBytes: number;
  readonly ttlMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: StemCacheOptions) {
    this.files = options.files;
    this.metadata = options.metadata;
    this.codec = options.codec;
    this.limitBytes = clampBytes(options.limitBytes, CACHE_LIMIT_BYTES);
    const entryLimit = clampBytes(options.maxEntryBytes, CACHE_ENTRY_LIMIT_BYTES);
    this.maxEntryBytes = Math.min(entryLimit, this.limitBytes);
    this.ttlMs =
      options.ttlMs === undefined || !Number.isFinite(options.ttlMs)
        ? CACHE_TTL_MS
        : Math.max(0, Math.floor(options.ttlMs));
    this.now = options.now ?? (() => Date.now());
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readEntries(): Promise<CachedEntry[]> {
    let raw: unknown;
    try {
      raw = await this.metadata.read();
    } catch {
      throw new CacheError('stem cache: metadata is unavailable');
    }
    return normaliseCacheMetadata(raw);
  }

  private async writeEntries(entries: readonly CachedEntry[]): Promise<void> {
    try {
      await this.metadata.write(entries);
    } catch {
      throw new CacheError('stem cache: metadata could not be saved');
    }
  }

  async cachedEntry(key: string): Promise<CachedEntry | null> {
    try {
      return (await this.readEntries()).find((entry) => entry.key === key) ?? null;
    } catch {
      return null;
    }
  }

  async hasCachedStems(key: string): Promise<boolean> {
    return (await this.cachedEntry(key)) !== null;
  }

  /** Newest use first. Metadata is small enough to read whole. */
  async listEntries(): Promise<readonly CachedEntry[]> {
    try {
      return [...(await this.readEntries())].sort(compareForListing);
    } catch {
      return [];
    }
  }

  /**
   * The one entry for a video's audio, or null.
   *
   * The key also carries the frame count, which is not known until the stream
   * has been decoded. So the record is found by the fields the engine does
   * know, and only accepted when exactly one entry matches. Two entries with
   * different lengths are two different decodes of the same video; playing
   * either under the other's clock would be a guess.
   */
  async findEntry(query: CacheEntryQuery): Promise<CachedEntry | null> {
    const videoId = query.videoId.trim();
    const modelVersion = query.modelVersion.trim();
    if (
      videoId === '' ||
      modelVersion === '' ||
      !isInteger(query.formatVersion, 0) ||
      !isInteger(query.sampleRate, 8000) ||
      query.sampleRate > 384000
    ) {
      return null;
    }
    try {
      const matches = (await this.readEntries()).filter(
        (entry) =>
          entry.videoId === videoId &&
          entry.modelVersion === modelVersion &&
          entry.formatVersion === query.formatVersion &&
          entry.sampleRate === query.sampleRate,
      );
      return matches.length === 1 ? (matches[0] as CachedEntry) : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes the other decodes of one video after a fresh write supersedes
   * them.
   *
   * Two entries for the same video, model, format and rate can disagree on
   * length when the page serves a differently padded encoding. Lookup refuses
   * to guess between them, so the next successful separation replaces the
   * stale copies instead of leaving every later start a miss.
   */
  async removeConflicts(query: CacheEntryQuery, keepKey: string): Promise<number> {
    const videoId = query.videoId.trim();
    const modelVersion = query.modelVersion.trim();
    return this.serial(async () => {
      const entries = await this.readEntries();
      const stale = entries.filter(
        (entry) =>
          entry.key !== keepKey &&
          entry.videoId === videoId &&
          entry.modelVersion === modelVersion &&
          entry.formatVersion === query.formatVersion &&
          entry.sampleRate === query.sampleRate,
      );
      if (stale.length === 0) {
        return 0;
      }
      for (const entry of stale) {
        try {
          await this.files.remove(entry.key);
        } catch {
          // The record goes either way; cleanup can remove an orphan.
        }
      }
      const staleKeys = new Set(stale.map((entry) => entry.key));
      await this.writeEntries(entries.filter((entry) => !staleKeys.has(entry.key)));
      return stale.length;
    });
  }

  async usage(): Promise<CacheUsage> {
    let entries: CachedEntry[] = [];
    try {
      entries = await this.readEntries();
    } catch {
      // A cache whose records cannot be read is empty as far as a readout is
      // concerned; it is not a reason to fail the session.
    }
    return {
      bytes: totalBytes(entries),
      count: entries.length,
      limitBytes: this.limitBytes,
    };
  }

  async touch(key: string): Promise<void> {
    // A use that cannot be recorded is not a failed load; the TTL is an
    // optimisation, and a missing update costs one eviction decision later.
    await this.serial(() => this.updateEntry(key, false)).catch(() => undefined);
  }

  async markPlayed(key: string): Promise<void> {
    await this.serial(() => this.updateEntry(key, true)).catch(() => undefined);
  }

  /**
   * Adds the Song card's facts to an existing entry, and nothing else.
   *
   * Analysis finishes after the stems are already written, so this is a small
   * metadata-only update. A missing entry is not an error: the session may
   * have stopped between the two, and the next play will analyse again.
   */
  async saveAnalysis(key: string, facts: SongFacts): Promise<boolean> {
    const clean = normaliseSongFacts(facts);
    return this.serial(() => this.setExtrasLocked(key, { analysis: clean }));
  }

  /** Adds the learnt guide melody to an existing entry, and nothing else. */
  async savePracticeNotes(
    key: string,
    notes: readonly PracticeNote[],
  ): Promise<boolean> {
    const clean = normalisePracticeNotes(notes);
    if (clean.length > MAX_CACHED_PRACTICE_NOTES) {
      return false;
    }
    return this.serial(() => this.setExtrasLocked(key, { practiceNotes: clean }));
  }

  private async setExtrasLocked(
    key: string,
    patch: Pick<CachedEntry, 'analysis' | 'practiceNotes'>,
  ): Promise<boolean> {
    const entries = await this.readEntries();
    const index = entries.findIndex((entry) => entry.key === key);
    if (index < 0) {
      return false;
    }
    const current = entries[index];
    if (current === undefined) {
      return false;
    }
    const next: CachedEntry = { ...current, ...patch };
    const updated = [...entries];
    updated[index] = next;
    await this.writeEntries(updated);
    return true;
  }

  private async updateEntry(key: string, played: boolean): Promise<void> {
    const entries = await this.readEntries();
    const index = entries.findIndex((entry) => entry.key === key);
    if (index < 0) {
      return;
    }
    const current = entries[index];
    if (current === undefined) {
      return;
    }
    const at = Math.max(this.now(), current.lastUsedAt);
    const next: CachedEntry = {
      ...current,
      lastUsedAt: at,
      playCount: played ? current.playCount + 1 : current.playCount,
    };
    const updated = [...entries];
    updated[index] = next;
    await this.writeEntries(updated);
  }

  /**
   * Reads four stems, dropping the entry if anything on disk disagrees with
   * the record. A missing or truncated stem is not a session failure: the
   * engine can separate again, which is exactly what a cache miss means.
   */
  async readCachedStems(key: string): Promise<CachedStems | null> {
    const entry = await this.cachedEntry(key);
    if (entry === null) {
      return null;
    }
    try {
      const stems = {} as Record<Stem, StereoChannels>;
      for (const stem of STEMS) {
        const bytes = await this.files.read(key, stem);
        if (bytes === null) {
          throw new CacheError('stem cache: a stem file is missing');
        }
        const parsed = parseStemFile(bytes);
        if (parsed === null) {
          throw new CacheError('stem cache: a stem file is corrupt');
        }
        this.checkHeader(parsed.header, entry);
        const channels = await this.codec.decode(parsed.packets, {
          sampleRate: entry.sampleRate,
          frames: entry.durationFrames,
        });
        if (
          channels.left.length !== entry.durationFrames ||
          channels.right.length !== entry.durationFrames
        ) {
          throw new CacheError('stem cache: a stem decoded to the wrong length');
        }
        stems[stem] = channels;
      }
      await this.touch(key).catch(() => undefined);
      return {
        key,
        sampleRate: entry.sampleRate,
        frames: entry.durationFrames,
        stems,
      };
    } catch {
      await this.removeEntry(key).catch(() => undefined);
      return null;
    }
  }

  private checkHeader(header: StemFileHeader, entry: CachedEntry): void {
    if (
      header.sampleRate !== entry.sampleRate ||
      header.frames !== entry.durationFrames ||
      header.codecRate !== this.codec.codecRate ||
      header.delayFrames !== this.codec.delayFrames ||
      header.codecId !== this.codec.id
    ) {
      throw new CacheError('stem cache: a stem file belongs to another format');
    }
  }

  async evictUntilUnder(limitBytes: number, protectedKey?: string): Promise<number> {
    return this.serial(() => this.evictLocked(limitBytes, protectedKey));
  }

  private async evictLocked(
    limitBytes: number,
    protectedKey?: string,
  ): Promise<number> {
    const target = Number.isFinite(limitBytes)
      ? Math.max(0, Math.floor(limitBytes))
      : 0;
    const entries = await this.readEntries();
    let bytes = totalBytes(entries);
    if (bytes <= target) {
      return 0;
    }
    const victims = entries
      .filter((entry) => entry.key !== protectedKey)
      .sort(compareForEviction);
    const kept = [...entries];
    let freed = 0;
    for (const victim of victims) {
      if (bytes <= target) {
        break;
      }
      try {
        await this.files.remove(victim.key);
      } catch {
        // The record goes either way; an orphaned directory is cleanup's job.
      }
      bytes -= victim.bytes;
      freed += victim.bytes;
      const at = kept.findIndex((entry) => entry.key === victim.key);
      if (at >= 0) {
        kept.splice(at, 1);
      }
    }
    if (kept.length !== entries.length) {
      await this.writeEntries(kept);
    }
    return freed;
  }

  async prune(now: number = this.now()): Promise<number> {
    const at = Number.isFinite(now) ? Math.floor(now) : this.now();
    return this.serial(() => this.pruneLocked(at));
  }

  private async pruneLocked(now: number): Promise<number> {
    const entries = await this.readEntries();
    const cutoff = now - this.ttlMs;
    const expired = entries.filter((entry) => entry.lastUsedAt < cutoff);
    if (expired.length === 0) {
      return 0;
    }
    for (const entry of expired) {
      try {
        await this.files.remove(entry.key);
      } catch {
        // Metadata is still dropped below.
      }
    }
    await this.writeEntries(
      entries.filter((entry) => entry.lastUsedAt >= cutoff),
    );
    return expired.length;
  }

  async removeEntry(key: string): Promise<void> {
    await this.serial(() => this.removeEntryLocked(key));
  }

  private async removeEntryLocked(key: string): Promise<void> {
    try {
      await this.files.remove(key);
    } catch {
      // A missing directory is the same as a removed one.
    }
    const entries = await this.readEntries();
    if (entries.some((entry) => entry.key === key)) {
      await this.writeEntries(entries.filter((entry) => entry.key !== key));
    }
  }

  async clearCache(): Promise<void> {
    await this.serial(async () => {
      try {
        await this.files.cleanup([]);
      } catch {
        // Still clear the records; a leftover orphan is cleaned next start.
      }
      await this.writeEntries([]);
    });
  }

  /**
   * Removes directories without a complete marker, and records whose files
   * did not survive. Called once when the extension starts.
   */
  async cleanupInterruptedWrites(): Promise<number> {
    return this.serial(async () => {
      let entries: CachedEntry[];
      try {
        entries = await this.readEntries();
      } catch {
        return 0;
      }
      const present: CachedEntry[] = [];
      let removed = 0;
      for (const entry of entries) {
        const complete = await this.files
          .hasComplete(entry.key)
          .catch(() => false);
        if (complete) {
          present.push(entry);
        } else {
          removed += 1;
          try {
            await this.files.remove(entry.key);
          } catch {
            // Nothing to remove, or already gone.
          }
        }
      }
      if (present.length !== entries.length) {
        await this.writeEntries(present);
      }
      try {
        removed += await this.files.cleanup(present.map((entry) => entry.key));
      } catch {
        // A run that cannot list the filesystem will try again next start.
      }
      return removed;
    });
  }

  async createStemWriter(options: StemWriterOptions): Promise<StemWriter> {
    const durationFrames = options.durationFrames;
    const sampleRate = options.sampleRate;
    const formatVersion = options.formatVersion;
    const videoId = options.videoId.trim();
    const modelVersion = options.modelVersion.trim();
    if (
      !isInteger(durationFrames, 1) ||
      !isInteger(sampleRate, 8000) ||
      sampleRate > 384000 ||
      !isInteger(formatVersion, 0) ||
      videoId === '' ||
      modelVersion === ''
    ) {
      throw new CacheError('stem cache: the entry is not valid');
    }
    const key = cacheKey(videoId, formatVersion, modelVersion, sampleRate, durationFrames);
    if (options.key !== key) {
      throw new CacheError('stem cache: the key does not match the entry');
    }
    const perEntryLimit = Math.min(
      clampBytes(options.maxBytes, this.maxEntryBytes),
      this.maxEntryBytes,
    );
    const input: CodecInput = { sampleRate, frames: durationFrames };
    const estimated =
      this.codec.estimateStemBytes(input) * STEMS.length +
      STEMS.length * (HEADER_BASE_BYTES + this.codec.id.length);
    if (estimated > perEntryLimit) {
      throw new CacheError('stem cache: the entry is larger than the per-entry limit');
    }

    const encoders = new Map<Stem, StemEncoder>();
    try {
      for (const stem of STEMS) {
        encoders.set(stem, await this.codec.createEncoder(input));
      }
    } catch (error) {
      for (const encoder of encoders.values()) {
        encoder.abort();
      }
      throw error;
    }
    try {
      await this.serial(async () => {
        try {
          await this.files.remove(key);
        } catch {
          // The old copy is replaced by the new one if it is still there.
        }
        const entries = await this.readEntries();
        if (entries.some((entry) => entry.key === key)) {
          await this.writeEntries(entries.filter((entry) => entry.key !== key));
        }
      });
    } catch (error) {
      for (const encoder of encoders.values()) {
        encoder.abort();
      }
      throw error;
    }

    return new StemWriterImpl({
      key,
      videoId,
      title: options.title
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, MAX_CACHE_TITLE_LENGTH)
        .trim(),
      artist: options.artist
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, MAX_CACHE_ARTIST_LENGTH)
        .trim(),
      durationFrames,
      sampleRate,
      modelVersion,
      formatVersion,
      perEntryLimit,
      limitBytes: this.limitBytes,
      codecId: this.codec.id,
      codecRate: this.codec.codecRate,
      codecDelay: this.codec.delayFrames,
      encoders,
      now: this.now,
      run: (task) => this.serial(task),
      evict: (limit, protectedKey) => this.evictLocked(limit, protectedKey),
      readEntries: () => this.readEntries(),
      writeEntries: (entries) => this.writeEntries(entries),
      beginFiles: (entryKey) => this.files.begin(entryKey),
      removeFiles: (entryKey) => this.files.remove(entryKey),
    });
  }
}

interface WriterParts {
  readonly key: string;
  readonly videoId: string;
  readonly title: string;
  readonly artist: string;
  readonly durationFrames: number;
  readonly sampleRate: number;
  readonly modelVersion: string;
  readonly formatVersion: number;
  readonly perEntryLimit: number;
  readonly limitBytes: number;
  readonly codecId: string;
  readonly codecRate: number;
  readonly codecDelay: number;
  readonly encoders: ReadonlyMap<Stem, StemEncoder>;
  readonly now: () => number;
  readonly run: <T>(task: () => Promise<T>) => Promise<T>;
  readonly evict: (limitBytes: number, protectedKey: string) => Promise<number>;
  readonly readEntries: () => Promise<CachedEntry[]>;
  readonly writeEntries: (entries: readonly CachedEntry[]) => Promise<void>;
  readonly beginFiles: (key: string) => Promise<EntryWriter>;
  readonly removeFiles: (key: string) => Promise<void>;
}

class StemWriterImpl implements StemWriter {
  private readonly parts: WriterParts;
  private readonly expected = new Map<Stem, number>();
  private readonly queues = new Map<Stem, Promise<void>>();
  private state: 'writing' | 'finishing' | 'finished' | 'aborted' = 'writing';

  constructor(parts: WriterParts) {
    this.parts = parts;
    for (const stem of STEMS) {
      this.expected.set(stem, 0);
      this.queues.set(stem, Promise.resolve());
    }
  }

  append(
    stem: Stem,
    startSample: number,
    left: Float32Array,
    right: Float32Array,
  ): Promise<void> {
    if (!isStem(stem)) {
      return Promise.reject(new CacheError('stem cache: unknown stem'));
    }
    const previous = this.queues.get(stem) ?? Promise.resolve();
    const task = previous.then(
      () => this.appendNow(stem, startSample, left, right),
      () => this.appendNow(stem, startSample, left, right),
    );
    this.queues.set(
      stem,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task.catch((error: unknown) => {
      this.fail();
      throw error;
    });
  }

  private async appendNow(
    stem: Stem,
    startSample: number,
    left: Float32Array,
    right: Float32Array,
  ): Promise<void> {
    if (this.state !== 'writing') {
      throw new CacheError('stem cache: the writer is closed');
    }
    if (
      !(left instanceof Float32Array) ||
      !(right instanceof Float32Array) ||
      left.length === 0 ||
      left.length !== right.length ||
      !Number.isSafeInteger(startSample) ||
      startSample < 0
    ) {
      throw new CacheError('stem cache: the block is not valid');
    }
    const expected = this.expected.get(stem) ?? 0;
    if (startSample !== expected) {
      throw new CacheError('stem cache: blocks arrived out of order');
    }
    if (startSample + left.length > this.parts.durationFrames) {
      throw new CacheError('stem cache: the block is past the end');
    }
    const encoder = this.parts.encoders.get(stem);
    if (encoder === undefined) {
      throw new CacheError('stem cache: no encoder for that stem');
    }
    await encoder.encode(left, right);
    this.expected.set(stem, startSample + left.length);
  }

  private fail(): void {
    if (this.state === 'finished' || this.state === 'aborted') {
      return;
    }
    this.state = 'aborted';
    for (const encoder of this.parts.encoders.values()) {
      encoder.abort();
    }
  }

  async finish(): Promise<CachedEntry> {
    if (this.state !== 'writing') {
      throw new CacheError('stem cache: the writer is closed');
    }
    for (const stem of STEMS) {
      if ((this.expected.get(stem) ?? 0) !== this.parts.durationFrames) {
        this.fail();
        throw new CacheError('stem cache: a stem is incomplete');
      }
    }
    this.state = 'finishing';

    const packets = new Map<Stem, readonly Uint8Array[]>();
    try {
      for (const stem of STEMS) {
        const encoder = this.parts.encoders.get(stem);
        if (encoder === undefined) {
          throw new CacheError('stem cache: no encoder for that stem');
        }
        packets.set(stem, await encoder.finish());
      }
    } catch (error) {
      this.fail();
      throw error;
    }

    const header = encodeHeader({
      sampleRate: this.parts.sampleRate,
      frames: this.parts.durationFrames,
      codecRate: this.parts.codecRate,
      delayFrames: this.parts.codecDelay,
      codecId: this.parts.codecId,
    });
    let bytes = 0;
    for (const stem of STEMS) {
      const stemPackets = packets.get(stem);
      if (stemPackets === undefined) {
        this.fail();
        throw new CacheError('stem cache: a stem is incomplete');
      }
      bytes += framedBytes(header, stemPackets);
    }
    if (bytes > this.parts.perEntryLimit) {
      this.fail();
      throw new CacheError('stem cache: the entry is larger than the per-entry limit');
    }
    if (bytes > this.parts.limitBytes) {
      this.fail();
      throw new CacheError('stem cache: the entry is larger than the cache');
    }

    const parts = this.parts;
    const key = this.parts.key;
    try {
      const entry = await parts.run(async () => {
        await parts.evict(parts.limitBytes - bytes, key);
        let committed = 0;
        let written = false;
        for (let attempt = 0; attempt < 2 && !written; attempt += 1) {
          const writer = await parts.beginFiles(key);
          try {
            for (const stem of STEMS) {
              const stemPackets = packets.get(stem) ?? [];
              await writer.write(stem, buildStemFile(header, stemPackets));
            }
            committed = await writer.commit();
            written = true;
          } catch (error) {
            await writer.abort().catch(() => undefined);
            if (attempt > 0 || !isQuotaExceeded(error)) {
              throw new CacheError('stem cache: out of space');
            }
            await parts.evict(
              Math.max(
                0,
                parts.limitBytes - bytes - QUOTA_RETRY_HEADROOM_BYTES,
              ),
              key,
            );
          }
        }
        if (!written || committed <= 0) {
          throw new CacheError('stem cache: the entry could not be written');
        }
        if (committed > this.parts.perEntryLimit) {
          await parts.removeFiles(key).catch(() => undefined);
          throw new CacheError('stem cache: the entry is larger than the per-entry limit');
        }
        const now = parts.now();
        const created: CachedEntry = {
          key,
          videoId: this.parts.videoId,
          title: this.parts.title,
          artist: this.parts.artist,
          durationFrames: this.parts.durationFrames,
          sampleRate: this.parts.sampleRate,
          modelVersion: this.parts.modelVersion,
          formatVersion: this.parts.formatVersion,
          bytes: committed,
          createdAt: now,
          lastUsedAt: now,
          playCount: 0,
          complete: true,
        };
        const entries = await parts.readEntries();
        try {
          await parts.writeEntries([
            ...entries.filter((item) => item.key !== key),
            created,
          ]);
        } catch (error) {
          await parts.removeFiles(key).catch(() => undefined);
          throw error;
        }
        await parts.evict(parts.limitBytes, key).catch(() => 0);
        return created;
      });
      this.state = 'finished';
      return entry;
    } catch (error) {
      this.fail();
      await parts.removeFiles(key).catch(() => undefined);
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.state === 'finished') {
      return;
    }
    if (this.state === 'finishing') {
      throw new CacheError('stem cache: the writer is closing');
    }
    this.fail();
    await this.parts.removeFiles(this.parts.key).catch(() => undefined);
  }
}


/** Builds a cache from its three storage-facing pieces. */
export function createStemCache(options: StemCacheOptions): StemCache {
  return new StemCache(options);
}
