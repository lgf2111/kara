import { STEMS, type Stem } from '../src/audio/stems.ts';
import {
  CACHE_METADATA_VERSION,
  cacheKey,
  type CachedEntry,
  type StereoChannels,
} from '../src/cache/entry.ts';
import type {
  CodecInput,
  MonoStemEncoder,
  StemCodec,
  StemEncoder,
} from '../src/cache/codec.ts';
import type {
  CacheFiles,
  DuetFiles,
  DuetVoice,
  DuetWriter,
  EntryWriter,
} from '../src/cache/opfs.ts';
import type { CacheMetadata } from '../src/cache/metadata-contract.ts';

/**
 * The OPFS stand-in: a map of entries, each with four byte arrays, an optional
 * duet sidecar and a complete flag. It copies what it is given, so a test that
 * mutates a buffer after writing is testing the cache rather than the fake.
 */
export interface FakeDuetEntry {
  voice1: Uint8Array;
  voice2: Uint8Array;
  map: string;
  partial: boolean;
}

export interface FakeFileEntry {
  complete: boolean;
  readonly stems: Map<Stem, Uint8Array[]>;
  duet: FakeDuetEntry | null;
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export class FakeCacheFiles implements CacheFiles {
  readonly entries = new Map<string, FakeFileEntry>();
  /** Commit attempts that throw QuotaExceededError before succeeding. */
  quotaFailures = 0;
  /** Duet commit attempts that fail, leaving the partial sidecar behind. */
  duetFailures = 0;
  begins = 0;
  duetBegins = 0;

  seed(key: string, complete = true): FakeFileEntry {
    const entry: FakeFileEntry = {
      complete,
      stems: new Map(),
      duet: null,
    };
    this.entries.set(key, entry);
    return entry;
  }

  begin(key: string): Promise<EntryWriter> {
    this.begins += 1;
    const entry = this.seed(key, false);
    let settled = false;
    return Promise.resolve({
      write: (stem, bytes) => {
        const chunks = entry.stems.get(stem) ?? [];
        chunks.push(new Uint8Array(bytes));
        entry.stems.set(stem, chunks);
        return Promise.resolve();
      },
      commit: () => {
        if (this.quotaFailures > 0) {
          this.quotaFailures -= 1;
          return Promise.reject(
            new DOMException('the disk is full', 'QuotaExceededError'),
          );
        }
        entry.complete = true;
        settled = true;
        let bytes = 0;
        for (const chunks of entry.stems.values()) {
          bytes += join(chunks).byteLength;
        }
        return Promise.resolve(bytes);
      },
      abort: () => {
        if (!settled) {
          this.entries.delete(key);
        }
        return Promise.resolve();
      },
    });
  }

  read(key: string, stem: Stem): Promise<Uint8Array | null> {
    const entry = this.entries.get(key);
    if (entry === undefined || !entry.complete) {
      return Promise.resolve(null);
    }
    return Promise.resolve(join(entry.stems.get(stem) ?? []));
  }

  readDuet(key: string): Promise<DuetFiles | null> {
    const entry = this.entries.get(key);
    if (entry === undefined || !entry.complete || entry.duet === null) {
      return Promise.resolve(null);
    }
    const { duet } = entry;
    if (duet.partial) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      voice1: new Uint8Array(duet.voice1),
      voice2: new Uint8Array(duet.voice2),
      map: duet.map,
    });
  }

  hasDuet(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    return Promise.resolve(
      entry !== undefined &&
        entry.complete &&
        entry.duet !== null &&
        !entry.duet.partial,
    );
  }

  beginDuet(key: string): Promise<DuetWriter> {
    const entry = this.entries.get(key);
    if (entry === undefined || !entry.complete) {
      return Promise.reject(new Error('the entry is not available for a duet'));
    }
    this.duetBegins += 1;
    entry.duet = {
      voice1: new Uint8Array(),
      voice2: new Uint8Array(),
      map: '',
      partial: true,
    };
    const duet = entry.duet;
    let settled = false;
    return Promise.resolve({
      writeVoice: (voice: DuetVoice, bytes: Uint8Array<ArrayBuffer>) => {
        if (voice === 1) {
          duet.voice1 = new Uint8Array(bytes);
        } else {
          duet.voice2 = new Uint8Array(bytes);
        }
        return Promise.resolve();
      },
      writeMap: (json: string) => {
        duet.map = json;
        return Promise.resolve();
      },
      commit: () => {
        if (this.duetFailures > 0) {
          this.duetFailures -= 1;
          return Promise.reject(
            new DOMException('the disk is full', 'QuotaExceededError'),
          );
        }
        if (duet.map === '') {
          return Promise.reject(new Error('the duet map was not written'));
        }
        duet.partial = false;
        settled = true;
        return Promise.resolve(
          duet.voice1.byteLength +
            duet.voice2.byteLength +
            new TextEncoder().encode(duet.map).byteLength,
        );
      },
      abort: () => {
        if (!settled) {
          entry.duet = null;
        }
        return Promise.resolve();
      },
    });
  }

  removeDuet(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      entry.duet = null;
    }
    return Promise.resolve();
  }

  hasComplete(key: string): Promise<boolean> {
    return Promise.resolve(this.entries.get(key)?.complete === true);
  }

  remove(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  cleanup(keys: readonly string[]): Promise<number> {
    const valid = new Set(keys);
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (!valid.has(key) || !entry.complete) {
        this.entries.delete(key);
        removed += 1;
      } else if (entry.duet?.partial === true) {
        entry.duet = null;
      }
    }
    return Promise.resolve(removed);
  }
}

/** The metadata stand-in, including the two failures the store must survive. */
export class FakeMetadata implements CacheMetadata {
  value: unknown;
  writes = 0;
  failReads = false;
  failWrites = false;

  constructor(entries: readonly CachedEntry[] = []) {
    this.value = { version: CACHE_METADATA_VERSION, entries };
  }

  read(): Promise<unknown> {
    if (this.failReads) {
      return Promise.reject(new Error('metadata read failed'));
    }
    return Promise.resolve(structuredClone(this.value));
  }

  write(entries: readonly CachedEntry[]): Promise<void> {
    if (this.failWrites) {
      return Promise.reject(new Error('metadata write failed'));
    }
    this.writes += 1;
    this.value = {
      version: CACHE_METADATA_VERSION,
      entries: structuredClone(entries),
    };
    return Promise.resolve();
  }

  entries(): CachedEntry[] {
    const record =
      typeof this.value === 'object' && this.value !== null
        ? (this.value as { readonly entries?: unknown })
        : {};
    return Array.isArray(record.entries)
      ? (record.entries as CachedEntry[])
      : [];
  }
}

/**
 * A codec that stores 16-bit stereo blocks, so a test can ask for exact
 * frames and sample values without WebCodecs. `estimateBytes` can be set
 * independently of the real size, which is how the eviction tests get
 * hundred-megabyte songs without allocating them.
 */
export class FakeCodec implements StemCodec {
  readonly id = 'fake';
  readonly codecRate = 48000;
  readonly delayFrames = 0;
  readonly bytesPerFrame: number;
  estimateBytes: number | null = null;
  failEncode = false;

  constructor(bytesPerFrame = 8) {
    this.bytesPerFrame = bytesPerFrame;
  }

  estimateStemBytes(input: CodecInput): number {
    return this.estimateBytes ?? input.frames * this.bytesPerFrame + 32;
  }

  estimateMonoBytes(input: CodecInput): number {
    return (
      this.estimateBytes ?? input.frames * (this.bytesPerFrame / 2) + 32
    );
  }

  createMonoEncoder(): Promise<MonoStemEncoder> {
    const packets: Uint8Array[] = [];
    return Promise.resolve({
      encode: (mono) => {
        if (this.failEncode) {
          return Promise.reject(new Error('the fake codec failed'));
        }
        const samples = new Int16Array(mono.length);
        for (let index = 0; index < mono.length; index += 1) {
          samples[index] = Math.round(
            Math.max(-1, Math.min(1, mono[index] ?? 0)) * 32767,
          );
        }
        packets.push(new Uint8Array(samples.buffer));
        return Promise.resolve();
      },
      finish: () => Promise.resolve(packets),
      abort: () => {
        packets.length = 0;
      },
    });
  }

  decodeMono(
    packets: readonly Uint8Array[],
    input: CodecInput,
  ): Promise<Float32Array> {
    const mono = new Float32Array(input.frames);
    let at = 0;
    for (const packet of packets) {
      const view = new DataView(
        packet.buffer,
        packet.byteOffset,
        packet.byteLength,
      );
      const frames = packet.byteLength / 2;
      for (let index = 0; index < frames && at + index < input.frames; index += 1) {
        mono[at + index] = view.getInt16(index * 2, true) / 32767;
      }
      at += frames;
    }
    return Promise.resolve(mono);
  }

  createEncoder(): Promise<StemEncoder> {
    const packets: Uint8Array[] = [];
    return Promise.resolve({
      encode: (left, right) => {
        if (this.failEncode) {
          return Promise.reject(new Error('the fake codec failed'));
        }
        const samples = new Int16Array(left.length * 2);
        for (let index = 0; index < left.length; index += 1) {
          samples[index * 2] = Math.round(
            Math.max(-1, Math.min(1, left[index] ?? 0)) * 32767,
          );
          samples[index * 2 + 1] = Math.round(
            Math.max(-1, Math.min(1, right[index] ?? 0)) * 32767,
          );
        }
        packets.push(new Uint8Array(samples.buffer));
        return Promise.resolve();
      },
      finish: () => Promise.resolve(packets),
      abort: () => {
        packets.length = 0;
      },
    });
  }

  decode(
    packets: readonly Uint8Array[],
    input: CodecInput,
  ): Promise<StereoChannels> {
    const left = new Float32Array(input.frames);
    const right = new Float32Array(input.frames);
    let at = 0;
    for (const packet of packets) {
      const view = new DataView(
        packet.buffer,
        packet.byteOffset,
        packet.byteLength,
      );
      const frames = packet.byteLength / 4;
      for (let index = 0; index < frames && at + index < input.frames; index += 1) {
        left[at + index] = view.getInt16(index * 4, true) / 32767;
        right[at + index] = view.getInt16(index * 4 + 2, true) / 32767;
      }
      at += frames;
    }
    return Promise.resolve({ left, right });
  }
}

/** A complete record whose key matches the fields the normaliser checks. */
export function seedEntry(
  videoId: string,
  patch: Partial<CachedEntry> = {},
): CachedEntry {
  const formatVersion = patch.formatVersion ?? 1;
  const modelVersion = patch.modelVersion ?? 'model';
  const sampleRate = patch.sampleRate ?? 44100;
  const durationFrames = patch.durationFrames ?? 1000;
  return {
    key: cacheKey(
      videoId,
      formatVersion,
      modelVersion,
      sampleRate,
      durationFrames,
    ),
    videoId,
    title: 'A Song',
    artist: 'An Artist',
    durationFrames,
    sampleRate,
    modelVersion,
    formatVersion,
    bytes: 1024,
    createdAt: 1_700_000_000_000,
    lastUsedAt: 1_700_000_000_000,
    playCount: 0,
    complete: true,
    ...patch,
  };
}

/** Writes every stem in blocks, in the order the engine would use. */
export async function writeSong(
  cache: {
    createStemWriter: (options: {
      key: string;
      videoId: string;
      title: string;
      artist: string;
      durationFrames: number;
      sampleRate: number;
      modelVersion: string;
      formatVersion: number;
      maxBytes?: number;
    }) => Promise<{
      append: (
        stem: Stem,
        startSample: number,
        left: Float32Array,
        right: Float32Array,
      ) => Promise<void>;
      finish: () => Promise<CachedEntry>;
      abort: () => Promise<void>;
    }>;
  },
  options: {
    videoId?: string;
    frames?: number;
    block?: number;
    sampleRate?: number;
    modelVersion?: string;
    formatVersion?: number;
    maxBytes?: number;
  } = {},
): Promise<CachedEntry> {
  const videoId = options.videoId ?? 'video-00001';
  const frames = options.frames ?? 1000;
  const block = options.block ?? 400;
  const sampleRate = options.sampleRate ?? 44100;
  const modelVersion = options.modelVersion ?? 'model';
  const formatVersion = options.formatVersion ?? 1;
  const key = cacheKey(
    videoId,
    formatVersion,
    modelVersion,
    sampleRate,
    frames,
  );
  const writerOptions = {
    key,
    videoId,
    title: 'A Song',
    artist: 'An Artist',
    durationFrames: frames,
    sampleRate,
    modelVersion,
    formatVersion,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  };
  const writer = await cache.createStemWriter(writerOptions);
  for (let start = 0; start < frames; start += block) {
    const length = Math.min(block, frames - start);
    for (const stem of STEMS) {
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        left[index] = ((start + index) % 100) / 1000;
        right[index] = -((start + index) % 100) / 1000;
      }
      await writer.append(stem, start, left, right);
    }
  }
  return writer.finish();
}
