import { describe, expect, it } from 'vitest';

import { STEMS, type Stem } from '../src/audio/stems.ts';
import {
  CACHE_ENTRY_LIMIT_BYTES,
  CACHE_LIMIT_BYTES,
  CACHE_TTL_MS,
  cacheKey,
} from '../src/cache/entry.ts';
import {
  createStemCache,
  type StemCache,
  type StemWriterOptions,
} from '../src/cache/store.ts';
import {
  FakeCacheFiles,
  FakeCodec,
  FakeMetadata,
  seedEntry,
  writeSong,
} from './cache-fakes.ts';

const NOW = 1_800_000_000_000;
const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

interface CacheOptions {
  readonly files?: FakeCacheFiles;
  readonly metadata?: FakeMetadata;
  readonly codec?: FakeCodec;
  readonly limitBytes?: number;
  readonly maxEntryBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function makeCache(options: CacheOptions = {}): {
  readonly cache: StemCache;
  readonly files: FakeCacheFiles;
  readonly metadata: FakeMetadata;
  readonly codec: FakeCodec;
} {
  const files = options.files ?? new FakeCacheFiles();
  const metadata = options.metadata ?? new FakeMetadata();
  const codec = options.codec ?? new FakeCodec();
  const cache = createStemCache({
    files,
    metadata,
    codec,
    limitBytes: options.limitBytes ?? CACHE_LIMIT_BYTES,
    maxEntryBytes: options.maxEntryBytes ?? CACHE_ENTRY_LIMIT_BYTES,
    ttlMs: options.ttlMs ?? CACHE_TTL_MS,
    now: options.now ?? (() => NOW),
  });
  return { cache, files, metadata, codec };
}

function writerOptions(
  videoId: string,
  frames: number,
  patch: Partial<StemWriterOptions> = {},
): StemWriterOptions {
  const fields = {
    videoId,
    title: 'A Song',
    artist: 'An Artist',
    durationFrames: frames,
    sampleRate: 44100,
    modelVersion: 'model',
    formatVersion: 1,
    ...patch,
  };
  return {
    ...fields,
    key:
      patch.key ??
      cacheKey(
        fields.videoId,
        fields.formatVersion,
        fields.modelVersion,
        fields.sampleRate,
        fields.durationFrames,
      ),
  };
}

async function appendFullStem(
  writer: Awaited<ReturnType<StemCache['createStemWriter']>>,
  stem: Stem,
  frames: number,
): Promise<void> {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  await writer.append(stem, 0, left, right);
}

describe('the cache writer', () => {
  it('saves four stems and reads them back at the exact frame count', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 5000, block: 1024 });

    expect(entry.complete).toBe(true);
    expect(entry.durationFrames).toBe(5000);
    expect(entry.bytes).toBeGreaterThan(0);
    expect(await cache.hasCachedStems(entry.key)).toBe(true);

    const loaded = await cache.readCachedStems(entry.key);
    expect(loaded).not.toBeNull();
    expect(loaded?.frames).toBe(5000);
    expect(loaded?.sampleRate).toBe(44100);
    if (loaded === null) {
      throw new Error('expected a cache hit');
    }
    for (const stem of STEMS) {
      const channels = loaded.stems[stem];
      expect(channels.left.length).toBe(5000);
      expect(channels.right.length).toBe(5000);
      expect(channels.left[123]).toBeCloseTo(0.023, 4);
      expect(channels.right[123]).toBeCloseTo(-0.023, 4);
    }

    const usage = await cache.usage();
    expect(usage.count).toBe(1);
    expect(usage.bytes).toBe(entry.bytes);
    expect(usage.limitBytes).toBe(CACHE_LIMIT_BYTES);
  });

  it('exposes nothing until finish, and not after abort', async () => {
    const { cache, metadata } = makeCache();
    const options = writerOptions('video-00001', 100);
    const writer = await cache.createStemWriter(options);
    const left = new Float32Array(100);
    await writer.append('drums', 0, left, left);

    expect(await cache.hasCachedStems(options.key)).toBe(false);
    expect(metadata.entries()).toEqual([]);

    await writer.abort();
    expect(await cache.hasCachedStems(options.key)).toBe(false);
    expect(await cache.readCachedStems(options.key)).toBeNull();
  });

  it('rejects an out-of-order block', async () => {
    const { cache } = makeCache();
    const writer = await cache.createStemWriter(writerOptions('video-00001', 100));
    const block = new Float32Array(5);

    await expect(writer.append('drums', 10, block, block)).rejects.toThrow(
      /out of order/u,
    );
    await writer.abort();
  });

  it('rejects a block whose channels are different lengths', async () => {
    const { cache } = makeCache();
    const writer = await cache.createStemWriter(writerOptions('video-00001', 100));

    await expect(
      writer.append('drums', 0, new Float32Array(10), new Float32Array(9)),
    ).rejects.toThrow(/not valid/u);
    await writer.abort();
  });

  it('rejects a block past the end of the song', async () => {
    const { cache } = makeCache();
    const writer = await cache.createStemWriter(writerOptions('video-00001', 100));
    const first = new Float32Array(90);
    const overrun = new Float32Array(20);

    await writer.append('drums', 0, first, first);
    await expect(writer.append('drums', 90, overrun, overrun)).rejects.toThrow(
      /past the end/u,
    );
    await writer.abort();
  });

  it('rejects an unknown stem and a second append after finish', async () => {
    const { cache } = makeCache();
    const options = writerOptions('video-00001', 100);
    const writer = await cache.createStemWriter(options);
    const block = new Float32Array(100);

    await expect(
      writer.append('piano' as Stem, 0, block, block),
    ).rejects.toThrow(/unknown stem/u);
    await writer.abort();

    const second = await cache.createStemWriter(options);
    for (const stem of STEMS) {
      await second.append(stem, 0, block, block);
    }
    await second.finish();

    await expect(second.append('drums', 100, block, block)).rejects.toThrow(
      /closed/u,
    );
  });

  it('refuses to finish with a stem that never arrived', async () => {
    const { cache, metadata } = makeCache();
    const writer = await cache.createStemWriter(writerOptions('video-00001', 100));
    await appendFullStem(writer, 'drums', 100);

    await expect(writer.finish()).rejects.toThrow(/incomplete/u);
    expect(metadata.entries()).toEqual([]);
  });
});

describe('eviction', () => {
  it('removes the least-played entry, then the oldest use', async () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      seedEntry(`video-${String(index).padStart(5, '0')}`, {
        bytes: 100 * MIB,
        playCount: index < 8 ? 5 : 1,
        lastUsedAt: NOW + index,
      }),
    );
    const metadata = new FakeMetadata(entries);
    const { cache } = makeCache({ metadata });

    const freed = await cache.evictUntilUnder(950 * MIB);

    expect(freed).toBe(100 * MIB);
    let remaining = new Set(metadata.entries().map((entry) => entry.videoId));
    expect(remaining.has('video-00008')).toBe(false);
    expect(remaining.has('video-00009')).toBe(true);
    expect(remaining.size).toBe(9);

    const more = await cache.evictUntilUnder(850 * MIB);

    expect(more).toBe(100 * MIB);
    remaining = new Set(metadata.entries().map((entry) => entry.videoId));
    expect(remaining.has('video-00009')).toBe(false);
    expect(remaining.size).toBe(8);
  });

  it('never evicts the protected key, even when it is least played', async () => {
    const entries = [
      seedEntry('video-00001', { bytes: 100 * MIB, playCount: 0 }),
      seedEntry('video-00002', { bytes: 100 * MIB, playCount: 9 }),
      seedEntry('video-00003', { bytes: 100 * MIB, playCount: 9 }),
    ];
    const metadata = new FakeMetadata(entries);
    const { cache } = makeCache({ metadata });
    const protectedKey = entries[0]?.key ?? '';

    const freed = await cache.evictUntilUnder(0, protectedKey);

    expect(freed).toBe(200 * MIB);
    expect(metadata.entries().map((entry) => entry.key)).toEqual([protectedKey]);
  });

  it('makes room before writing a new song', async () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      seedEntry(`video-${String(index).padStart(5, '0')}`, {
        bytes: 100 * MIB,
        playCount: index === 8 ? 0 : 5,
        lastUsedAt: NOW + index,
      }),
    );
    const metadata = new FakeMetadata(entries);
    const codec = new FakeCodec();
    const { cache } = makeCache({ metadata, codec });

    const entry = await writeSong(cache, {
      videoId: 'new-video01',
      frames: 2_000_000,
      block: 2_000_000,
    });

    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    const remaining = new Set(metadata.entries().map((item) => item.videoId));
    expect(remaining.has('video-00008')).toBe(false);
    expect(remaining.size).toBe(10);
  });
});

describe('limits', () => {
  it('rejects a song that the per-entry cap can never hold', async () => {
    const codec = new FakeCodec();
    codec.estimateBytes = 1000;
    const { cache } = makeCache({ codec, maxEntryBytes: 1000 });

    await expect(
      writeSong(cache, { videoId: 'video-00001', frames: 1000 }),
    ).rejects.toThrow(/per-entry/u);
  });

  it('rejects at finish when the actual bytes exceed the per-entry cap', async () => {
    const codec = new FakeCodec();
    codec.estimateBytes = 1;
    const { cache, metadata, files } = makeCache({
      codec,
      maxEntryBytes: 1000,
    });

    await expect(
      writeSong(cache, { videoId: 'video-00001', frames: 1000 }),
    ).rejects.toThrow(/per-entry/u);
    expect(metadata.entries()).toEqual([]);
    expect(files.entries.size).toBe(0);
  });

  it('evicts more and retries after a quota error', async () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      seedEntry(`video-${String(index).padStart(5, '0')}`, {
        bytes: 100 * MIB,
        playCount: index < 8 ? 5 : 0,
        lastUsedAt: NOW + index,
      }),
    );
    const metadata = new FakeMetadata(entries);
    const files = new FakeCacheFiles();
    files.quotaFailures = 1;
    const codec = new FakeCodec();
    codec.estimateBytes = 25 * MIB;
    const { cache } = makeCache({
      metadata,
      files,
      codec,
      limitBytes: 950 * MIB,
    });

    const entry = await writeSong(cache, {
      videoId: 'new-video01',
      frames: 1000,
    });

    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    const remaining = new Set(metadata.entries().map((item) => item.videoId));
    expect(remaining.has('video-00008')).toBe(false);
    expect(remaining.has('video-00009')).toBe(false);
    expect(remaining.has('new-video01')).toBe(true);
  });

  it('fails cleanly when the quota error survives the retry', async () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      seedEntry(`video-${String(index).padStart(5, '0')}`, {
        bytes: 100 * MIB,
        playCount: index < 8 ? 5 : 0,
        lastUsedAt: NOW + index,
      }),
    );
    const metadata = new FakeMetadata(entries);
    const files = new FakeCacheFiles();
    files.quotaFailures = 2;
    const codec = new FakeCodec();
    codec.estimateBytes = 25 * MIB;
    const { cache } = makeCache({
      metadata,
      files,
      codec,
      limitBytes: 950 * MIB,
    });
    const key = cacheKey('new-video01', 1, 'model', 44100, 1000);

    await expect(
      writeSong(cache, { videoId: 'new-video01', frames: 1000 }),
    ).rejects.toThrow(/out of space/u);

    expect(await cache.hasCachedStems(key)).toBe(false);
    expect(metadata.entries().some((entry) => entry.key === key)).toBe(false);
    expect(files.entries.has(key)).toBe(false);
  });
});

describe('expiry and clearing', () => {
  it('prunes an entry unused for longer than the TTL', async () => {
    const old = seedEntry('video-00001', {
      lastUsedAt: NOW - 91 * DAY,
      createdAt: NOW - 100 * DAY,
    });
    const fresh = seedEntry('video-00002', {
      lastUsedAt: NOW - 89 * DAY,
      createdAt: NOW - 100 * DAY,
    });
    const metadata = new FakeMetadata([old, fresh]);
    const files = new FakeCacheFiles();
    files.seed(old.key);
    files.seed(fresh.key);
    const { cache } = makeCache({ metadata, files });

    const removed = await cache.prune(NOW);

    expect(removed).toBe(1);
    expect(metadata.entries().map((entry) => entry.key)).toEqual([fresh.key]);
    expect(files.entries.has(old.key)).toBe(false);
    expect(files.entries.has(fresh.key)).toBe(true);
  });

  it('clears every file and every record', async () => {
    const first = seedEntry('video-00001');
    const second = seedEntry('video-00002');
    const metadata = new FakeMetadata([first, second]);
    const files = new FakeCacheFiles();
    files.seed(first.key);
    files.seed(second.key);
    const { cache } = makeCache({ metadata, files });

    await cache.clearCache();

    expect(await cache.usage()).toEqual({
      bytes: 0,
      count: 0,
      limitBytes: CACHE_LIMIT_BYTES,
    });
    expect(metadata.entries()).toEqual([]);
    expect(files.entries.size).toBe(0);
  });
});

describe('use and accounting', () => {
  it('touches and counts plays without losing an update', async () => {
    let clock = NOW;
    const { cache } = makeCache({ now: () => clock });
    const entry = await writeSong(cache, { frames: 1000 });

    clock += 1000;
    await cache.touch(entry.key);
    let stored = await cache.cachedEntry(entry.key);
    expect(stored?.lastUsedAt).toBe(NOW + 1000);
    expect(stored?.playCount).toBe(0);

    clock += 1000;
    await Promise.all([
      cache.markPlayed(entry.key),
      cache.markPlayed(entry.key),
    ]);
    stored = await cache.cachedEntry(entry.key);
    expect(stored?.playCount).toBe(2);
    expect(stored?.lastUsedAt).toBe(NOW + 2000);

    clock += 1000;
    await Promise.all([cache.touch(entry.key), cache.markPlayed(entry.key)]);
    stored = await cache.cachedEntry(entry.key);
    expect(stored?.playCount).toBe(3);
    expect(stored?.lastUsedAt).toBe(NOW + 3000);

    const usage = await cache.usage();
    expect(usage).toEqual({
      bytes: entry.bytes,
      count: 1,
      limitBytes: CACHE_LIMIT_BYTES,
    });
  });

  it('removes one entry without touching the others', async () => {
    const first = seedEntry('video-00001');
    const second = seedEntry('video-00002');
    const metadata = new FakeMetadata([first, second]);
    const files = new FakeCacheFiles();
    files.seed(first.key);
    files.seed(second.key);
    const { cache } = makeCache({ metadata, files });

    await cache.removeEntry(first.key);

    expect(metadata.entries().map((entry) => entry.key)).toEqual([second.key]);
    expect(files.entries.has(first.key)).toBe(false);
    expect(files.entries.has(second.key)).toBe(true);
  });

  it('reads an empty cache as empty when metadata is unavailable', async () => {
    const metadata = new FakeMetadata();
    metadata.failReads = true;
    const { cache } = makeCache({ metadata });

    expect(await cache.hasCachedStems('anything')).toBe(false);
    expect(await cache.listEntries()).toEqual([]);
    expect(await cache.usage()).toEqual({
      bytes: 0,
      count: 0,
      limitBytes: CACHE_LIMIT_BYTES,
    });
  });
});

describe('damage recovery', () => {
  it('never reports an incomplete record as a hit', async () => {
    const entry = seedEntry('video-00001');
    const metadata = new FakeMetadata([{ ...entry, complete: false }]);
    const files = new FakeCacheFiles();
    files.seed(entry.key, false);
    const { cache } = makeCache({ metadata, files });

    expect(await cache.hasCachedStems(entry.key)).toBe(false);
    expect(await cache.listEntries()).toEqual([]);

    expect(await cache.cleanupInterruptedWrites()).toBe(1);
    expect(files.entries.has(entry.key)).toBe(false);
  });

  it('drops a record when its files are missing', async () => {
    const { cache, files } = makeCache();
    const entry = await writeSong(cache, { videoId: 'video-00001', frames: 1000 });
    await files.remove(entry.key);

    expect(await cache.readCachedStems(entry.key)).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(false);
  });

  it('drops a record when a stem file is corrupt', async () => {
    const { cache, files } = makeCache();
    const entry = await writeSong(cache, { videoId: 'video-00001', frames: 1000 });
    const stored = files.entries.get(entry.key);
    if (stored === undefined) {
      throw new Error('expected the fake entry');
    }
    stored.stems.set('drums', [new Uint8Array([1, 2, 3])]);

    expect(await cache.readCachedStems(entry.key)).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(false);
  });

  it('cleans interrupted directories and orphan records on startup', async () => {
    const good = seedEntry('video-00001');
    const missing = seedEntry('video-00002');
    const metadata = new FakeMetadata([good, missing]);
    const files = new FakeCacheFiles();
    files.seed(good.key, true);
    files.seed(missing.key, false);
    files.seed('orphaned-directory', false);
    const { cache } = makeCache({ metadata, files });

    const removed = await cache.cleanupInterruptedWrites();

    expect(removed).toBe(2);
    expect(metadata.entries().map((entry) => entry.key)).toEqual([good.key]);
    expect(files.entries.has(good.key)).toBe(true);
    expect(files.entries.has(missing.key)).toBe(false);
    expect(files.entries.has('orphaned-directory')).toBe(false);
  });
});
