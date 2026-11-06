import type { PracticeNote } from '../audio/practice.ts';
import type { SongFacts } from '../audio/song-analysis.ts';
import { STEMS } from '../audio/stems.ts';
import {
  CACHE_FORMAT_VERSION,
  cacheKey,
  type CachedEntry,
  type CachedStems,
} from '../cache/entry.ts';
import type { CacheStatus } from '../cache/status.ts';
import type { CacheEntryQuery, StemWriter } from '../cache/store.ts';

/**
 * One session's encounter with the stem cache.
 *
 * This is the whole cache policy the engine needs, kept out of the audio
 * graph so it can be driven by a fake store in a test:
 *
 * - **Start.** Ask for the one complete entry for this video, model, format
 *   and rate. A hit returns the decoded stems and touches the record. A miss
 *   is not an error; it is the normal session.
 * - **Write.** On a miss, once the decoded frame count is known, open a
 *   writer. `appendBlock` copies each separated block synchronously and then
 *   encodes it on the writer's own queue, so neither the player nor the
 *   separation frontier waits for the cache.
 * - **Extras.** Song facts and the practice melody arrive after the stems are
 *   written. They are attached to the same entry, or held until the writer
 *   finishes if they win the race.
 * - **Failure is never the session's failure.** An unavailable cache, a full
 *   disk or a codec without Opus turns into an `error` status and nothing
 *   else; the song plays from the separation that is already running.
 */

/** The store methods this policy uses, so a test can supply a fake. */
export interface StemCacheStore {
  findEntry(query: CacheEntryQuery): Promise<CachedEntry | null>;
  readCachedStems(key: string): Promise<CachedStems | null>;
  createStemWriter(options: {
    readonly key: string;
    readonly videoId: string;
    readonly title: string;
    readonly artist: string;
    readonly durationFrames: number;
    readonly sampleRate: number;
    readonly modelVersion: string;
    readonly formatVersion: number;
  }): Promise<StemWriter>;
  saveAnalysis(key: string, facts: SongFacts): Promise<boolean>;
  savePracticeNotes(key: string, notes: readonly PracticeNote[]): Promise<boolean>;
  markPlayed(key: string): Promise<void>;
  /** Drops older entries for the same video after a fresh write wins. */
  removeConflicts(query: CacheEntryQuery, keepKey: string): Promise<number>;
}

export interface StemCacheSessionOptions {
  readonly cache: StemCacheStore;
  readonly videoId: string;
  readonly modelVersion: string;
  /** Defaults to the entry format this build writes. */
  readonly formatVersion?: number;
  readonly sampleRate: number;
  /** Cosmetic words in the metadata; an empty title is allowed. */
  readonly title: string;
  readonly artist: string;
  readonly onStatus: (status: CacheStatus) => void;
}

export type CacheStart =
  | {
      readonly kind: 'hit';
      readonly entry: CachedEntry;
      readonly stems: CachedStems;
    }
  | { readonly kind: 'miss' };

export class StemCacheSession {
  private readonly cache: StemCacheStore;
  private readonly videoId: string;
  private readonly modelVersion: string;
  private readonly formatVersion: number;
  private readonly sampleRate: number;
  private readonly title: string;
  private readonly artist: string;
  private readonly onStatus: (status: CacheStatus) => void;

  private writer: Promise<StemWriter | null> | null = null;
  private key: string | null = null;
  private entry: CachedEntry | null = null;
  private savedEntry: CachedEntry | null = null;
  private finished: Promise<CachedEntry | null> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failed = false;
  private aborted = false;
  private finishing = false;
  private pendingAnalysis: SongFacts | null = null;
  private pendingNotes: readonly PracticeNote[] | null = null;
  private statusValue: CacheStatus = {
    state: 'checking',
    bytes: null,
    detail: null,
  };

  constructor(options: StemCacheSessionOptions) {
    this.cache = options.cache;
    this.videoId = options.videoId;
    this.modelVersion = options.modelVersion;
    this.formatVersion = options.formatVersion ?? CACHE_FORMAT_VERSION;
    this.sampleRate = options.sampleRate;
    this.title = options.title;
    this.artist = options.artist;
    this.onStatus = options.onStatus;
  }

  status(): CacheStatus {
    return this.statusValue;
  }

  /** The entry this session is reading or writing, once it is known. */
  entryKey(): string | null {
    return this.key;
  }

  private set(next: CacheStatus): void {
    this.statusValue = next;
    this.onStatus(next);
  }

  /**
   * Asks for a hit. Any failure is a miss with an `error` readout; the caller
   * then runs the ordinary session, which is always a valid answer.
   */
  async start(): Promise<CacheStart> {
    this.set({ state: 'checking', bytes: null, detail: null });
    try {
      const entry = await this.cache.findEntry({
        videoId: this.videoId,
        modelVersion: this.modelVersion,
        formatVersion: this.formatVersion,
        sampleRate: this.sampleRate,
      });
      if (entry === null) {
        this.set({ state: 'miss', bytes: null, detail: 'Not cached yet.' });
        return { kind: 'miss' };
      }
      const stems = await this.cache.readCachedStems(entry.key);
      if (
        stems === null ||
        stems.frames !== entry.durationFrames ||
        stems.sampleRate !== entry.sampleRate
      ) {
        this.set({
          state: 'miss',
          bytes: null,
          detail: 'The cached stems could not be read.',
        });
        return { kind: 'miss' };
      }
      this.key = entry.key;
      this.entry = entry;
      this.set({
        state: 'hit',
        bytes: entry.bytes,
        detail: 'Loaded from cache.',
      });
      return { kind: 'hit', entry, stems };
    } catch {
      this.set({ state: 'error', bytes: null, detail: 'Cache unavailable.' });
      return { kind: 'miss' };
    }
  }

  /**
   * Opens the writer for a miss. The key needs the decoded frame count, which
   * is why this is separate from `start`.
   */
  beginWrite(durationFrames: number): void {
    if (this.failed || this.aborted || this.writer !== null) {
      return;
    }
    const key = cacheKey(
      this.videoId,
      this.formatVersion,
      this.modelVersion,
      this.sampleRate,
      durationFrames,
    );
    this.key = key;
    this.set({ state: 'writing', bytes: null, detail: 'Saving cache…' });
    this.writer = this.cache
      .createStemWriter({
        key,
        videoId: this.videoId,
        title: this.title,
        artist: this.artist,
        durationFrames,
        sampleRate: this.sampleRate,
        modelVersion: this.modelVersion,
        formatVersion: this.formatVersion,
      })
      .then(
        (writer) => writer,
        () => {
          this.fail('The cache could not start a writer.');
          return null;
        },
      );
  }

  /**
   * Feeds one separated block to the writer.
   *
   * The copy is made here, synchronously, because the engine transfers the
   * originals to the player immediately afterwards. Encoding happens on the
   * session's queue, not on the caller's stack, so separation is never held
   * behind a disk write.
   */
  appendBlock(startSample: number, channels: readonly Float32Array[]): void {
    if (this.failed || this.aborted || this.finishing || this.writer === null) {
      return;
    }
    const copies = channels
      .slice(0, STEMS.length * 2)
      .map((channel) => channel.slice());
    if (copies.length !== STEMS.length * 2) {
      return;
    }
    const frames = copies[0]?.length ?? 0;
    if (frames <= 0) {
      return;
    }
    this.chain = this.chain
      .then(async () => {
        if (this.failed || this.aborted || this.writer === null) {
          return;
        }
        const writer = await this.writer;
        if (writer === null || this.failed || this.aborted) {
          return;
        }
        for (const [index, stem] of STEMS.entries()) {
          const left = copies[index * 2];
          const right = copies[index * 2 + 1];
          if (left === undefined || right === undefined) {
            throw new Error('stem cache: a block is missing a channel');
          }
          await writer.append(stem, startSample, left, right);
        }
      })
      .catch(() => {
        this.fail('The cache could not save the stems.');
      });
  }

  /**
   * Closes the writer after the last block. Resolves to the complete entry,
   * or null when the cache failed; it never rejects into the session.
   */
  finish(): Promise<CachedEntry | null> {
    if (this.finished !== null) {
      return this.finished;
    }
    if (this.writer === null) {
      return Promise.resolve(null);
    }
    this.finishing = true;
    this.finished = this.chain
      .then(async () => {
        if (this.failed || this.aborted) {
          return null;
        }
        const writer = await this.writer;
        if (writer === null) {
          return null;
        }
        const entry = await writer.finish();
        this.savedEntry = entry;
        await this.cache
          .removeConflicts(
            {
              videoId: this.videoId,
              modelVersion: this.modelVersion,
              formatVersion: this.formatVersion,
              sampleRate: this.sampleRate,
            },
            entry.key,
          )
          .catch(() => 0);
        if (this.pendingAnalysis !== null) {
          await this.cache
            .saveAnalysis(entry.key, this.pendingAnalysis)
            .catch(() => false);
          this.pendingAnalysis = null;
        }
        if (this.pendingNotes !== null) {
          await this.cache
            .savePracticeNotes(entry.key, this.pendingNotes)
            .catch(() => false);
          this.pendingNotes = null;
        }
        this.set({ state: 'ready', bytes: entry.bytes, detail: null });
        // The freshly written entry was just used by this session. Counting
        // that play keeps a new song from being the first eviction victim.
        await this.cache.markPlayed(entry.key).catch(() => undefined);
        return entry;
      })
      .catch(() => {
        this.fail('The cache could not save the stems.');
        return null;
      });
    return this.finished;
  }

  /** Stops an unfinished write. A write already finishing is left alone. */
  async abort(): Promise<void> {
    if (this.aborted) {
      return;
    }
    if (this.finished !== null) {
      await this.finished.catch(() => null);
      return;
    }
    this.aborted = true;
    if (this.writer === null) {
      return;
    }
    const writer = await this.writer.catch(() => null);
    await writer?.abort().catch(() => undefined);
  }

  /**
   * Remembers the Song card's facts. On a hit the entry already exists; on a
   * miss this waits for the writer unless it has already finished.
   */
  saveAnalysis(facts: SongFacts): Promise<void> {
    if (this.key === null) {
      return Promise.resolve();
    }
    if (this.savedEntry !== null) {
      return this.cache
        .saveAnalysis(this.savedEntry.key, facts)
        .then(() => undefined)
        .catch(() => undefined);
    }
    if (this.entry !== null) {
      return this.cache
        .saveAnalysis(this.key, facts)
        .then(() => undefined)
        .catch(() => undefined);
    }
    this.pendingAnalysis = facts;
    return Promise.resolve();
  }

  /** Remembers the learnt guide melody, by the same rules as the facts. */
  savePracticeNotes(notes: readonly PracticeNote[]): Promise<void> {
    if (this.key === null) {
      return Promise.resolve();
    }
    if (this.savedEntry !== null) {
      return this.cache
        .savePracticeNotes(this.savedEntry.key, notes)
        .then(() => undefined)
        .catch(() => undefined);
    }
    if (this.entry !== null) {
      return this.cache
        .savePracticeNotes(this.key, notes)
        .then(() => undefined)
        .catch(() => undefined);
    }
    this.pendingNotes = notes;
    return Promise.resolve();
  }

  /** Counts one use; a failure here is not a failed play. */
  markPlayed(): Promise<void> {
    if (this.key === null) {
      return Promise.resolve();
    }
    return this.cache.markPlayed(this.key).catch(() => undefined);
  }

  private fail(detail: string): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.set({ state: 'error', bytes: null, detail });
    if (this.writer !== null) {
      void this.writer
        .then((writer) => writer?.abort())
        .catch(() => undefined);
    }
  }
}
