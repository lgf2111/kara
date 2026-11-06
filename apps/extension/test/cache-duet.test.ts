import { describe, expect, it } from 'vitest';

import { STEMS } from '../src/audio/stems.ts';
import {
  CACHE_FORMAT_VERSION,
  CACHE_LIMIT_BYTES,
  CACHE_TTL_MS,
  cacheKey,
} from '../src/cache/entry.ts';
import { DUET_FORMAT_VERSION } from '../src/cache/duet.ts';
import {
  createStemCache,
  type StemCache,
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
    maxEntryBytes: options.maxEntryBytes ?? 256 * MIB,
    ttlMs: options.ttlMs ?? CACHE_TTL_MS,
    now: options.now ?? (() => NOW),
  });
  return { cache, files, metadata, codec };
}

function voices(frames: number, offset = 0): [Float32Array, Float32Array] {
  const first = new Float32Array(frames);
  const second = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    first[index] = ((index + offset) % 200) / 1000 - 0.1;
    second[index] = -((index + offset) % 200) / 1000 + 0.1;
  }
  return [first, second];
}

function duetMap(): Record<string, unknown> {
  return {
    version: 1,
    sampleRate: 44100,
    durationSeconds: 4.321,
    anchors: [
      { voice: 1, start: 1.5, end: 4.5 },
      { voice: 2, start: 8, end: 11 },
    ],
    segments: [
      {
        start: 0,
        end: 2,
        kind: 'solo',
        voice: 1,
        voice1Slot: 1,
        confidence: 0.91,
        reason: 'energy',
      },
    ],
    quality: {
      solo: 12.5,
      both: 3,
      unison: 1,
      none: 7,
      lowConfidence: 0.5,
    },
  };
}

async function writeDuet(
  cache: StemCache,
  key: string,
  frames: number,
  patch: {
    helperVersion?: string;
    duetFormatVersion?: number;
    modelVersion?: string;
  } = {},
): Promise<Awaited<ReturnType<StemCache['writeCachedDuet']>>> {
  const [voice1, voice2] = voices(frames);
  return cache.writeCachedDuet(key, {
    voices: [voice1, voice2],
    map: duetMap(),
    helperVersion: patch.helperVersion ?? 'helper-1',
    duetFormatVersion: patch.duetFormatVersion ?? DUET_FORMAT_VERSION,
    ...(patch.modelVersion === undefined
      ? {}
      : { modelVersion: patch.modelVersion }),
  });
}

describe('the duet sidecar', () => {
  it('round-trips two mono voices at the exact frame count and keeps the map', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 4321, block: 700 });
    const updated = await writeDuet(cache, entry.key, 4321);
    const map = duetMap();

    expect(updated.formatVersion).toBe(entry.formatVersion);
    expect(updated.bytes).toBeGreaterThan(entry.bytes);
    expect(updated.duet?.frames).toBe(4321);
    expect(updated.duet?.sampleRate).toBe(44100);
    expect(updated.duet?.helperVersion).toBe('helper-1');
    expect(updated.duet?.duetFormatVersion).toBe(DUET_FORMAT_VERSION);
    expect(updated.duet?.bytes).toBe(updated.bytes - entry.bytes);

    expect(await cache.hasCachedDuet(entry.key)).toBe(true);
    const loaded = await cache.readCachedDuet(entry.key);
    expect(loaded).not.toBeNull();
    if (loaded === null) {
      throw new Error('expected a duet hit');
    }
    expect(loaded.frames).toBe(4321);
    expect(loaded.sampleRate).toBe(44100);
    expect(loaded.voice1.length).toBe(4321);
    expect(loaded.voice2.length).toBe(4321);
    expect(loaded.voices[0]).toBe(loaded.voice1);
    expect(loaded.voices[1]).toBe(loaded.voice2);
    expect(loaded.voices.voice1).toBe(loaded.voice1);
    expect(loaded.voices.voice2).toBe(loaded.voice2);
    expect(loaded.voice1[123]).toBeCloseTo(0.023, 2);
    expect(loaded.voice2[123]).toBeCloseTo(-0.023, 2);
    expect(loaded.map).toEqual(map);
    expect(loaded.quality).toEqual(map['quality']);
    expect(loaded.anchors).toEqual(map['anchors']);
    expect(loaded.helperVersion).toBe('helper-1');
    expect(loaded.modelVersion).toBeNull();
    expect(loaded.duetFormatVersion).toBe(DUET_FORMAT_VERSION);

    // The base stems are still the same complete entry.
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    const stems = await cache.readCachedStems(entry.key);
    expect(stems?.frames).toBe(4321);
    for (const stem of STEMS) {
      expect(stems?.stems[stem].left.length).toBe(4321);
    }
  });

  it('accepts named voices and an empty map', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 999 });
    const [voice1, voice2] = voices(999);
    await cache.writeCachedDuet(entry.key, {
      voices: { voice1, voice2 },
      map: {},
      helperVersion: 'helper-2',
      duetFormatVersion: DUET_FORMAT_VERSION,
    });

    const loaded = await cache.readCachedDuet(entry.key);
    expect(loaded?.voice1.length).toBe(999);
    expect(loaded?.map).toEqual({});
    expect(loaded?.anchors).toEqual([]);
    expect(loaded?.quality).toEqual({});
  });

  it('refuses voices that do not match the song length', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });

    await expect(
      cache.writeCachedDuet(entry.key, {
        voices: voices(999),
        map: duetMap(),
        helperVersion: 'helper-1',
        duetFormatVersion: DUET_FORMAT_VERSION,
      }),
    ).rejects.toThrow(/do not match the song/u);
    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
  });

  it('reports a miss when the sidecar is absent, and leaves the stems usable', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });

    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.readCachedDuet(entry.key)).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    expect((await cache.readCachedStems(entry.key))?.frames).toBe(1000);
  });

  it('returns a duet miss for corrupt files without dropping the entry', async () => {
    const { cache, files, metadata } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });
    const baseBytes = entry.bytes;
    await writeDuet(cache, entry.key, 1000);

    const stored = files.entries.get(entry.key);
    if (stored?.duet === null || stored?.duet === undefined) {
      throw new Error('expected a stored duet');
    }
    stored.duet.voice1 = new Uint8Array([1, 2, 3]);

    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.readCachedDuet(entry.key)).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    expect((await cache.readCachedStems(entry.key))?.frames).toBe(1000);
    expect(metadata.entries().map((item) => item.key)).toEqual([entry.key]);
    expect(metadata.entries()[0]?.bytes).toBeGreaterThan(baseBytes);
  });

  it('returns a duet miss when the map or a version does not match', async () => {
    const { cache, files } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });
    await writeDuet(cache, entry.key, 1000);

    const stored = files.entries.get(entry.key);
    if (stored?.duet === null || stored?.duet === undefined) {
      throw new Error('expected a stored duet');
    }
    const oldMap = stored.duet.map;
    stored.duet.map = 'not json';
    expect(await cache.readCachedDuet(entry.key)).toBeNull();
    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.hasCachedStems(entry.key)).toBe(true);

    stored.duet.map = oldMap;
    expect(await cache.hasCachedDuet(entry.key)).toBe(true);

    // A valid sidecar whose helper version disagrees with the entry record is
    // still a sidecar miss, not a reason to lose the stems.
    const parsed = JSON.parse(stored.duet.map) as { helperVersion: string };
    parsed.helperVersion = 'helper-other';
    stored.duet.map = JSON.stringify(parsed);
    expect(await cache.readCachedDuet(entry.key)).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
  });

  it('does not read a duet written with another duet format version', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });
    await writeDuet(cache, entry.key, 1000, { duetFormatVersion: 99 });

    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.readCachedDuet(entry.key)).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    expect((await cache.readCachedStems(entry.key))?.frames).toBe(1000);
  });

  it('honours an expected helper or format version', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 500 });
    await writeDuet(cache, entry.key, 500, { helperVersion: 'helper-3' });

    expect(
      await cache.hasCachedDuet(entry.key, { helperVersion: 'helper-3' }),
    ).toBe(true);
    expect(
      await cache.hasCachedDuet(entry.key, { helperVersion: 'helper-4' }),
    ).toBe(false);
    expect(
      await cache.readCachedDuet(entry.key, {
        duetFormatVersion: DUET_FORMAT_VERSION,
      }),
    ).not.toBeNull();
    expect(
      await cache.readCachedDuet(entry.key, {
        duetFormatVersion: DUET_FORMAT_VERSION + 1,
      }),
    ).toBeNull();
  });

  it('keeps touch and markPlayed working with a duet present', async () => {
    let clock = NOW;
    const { cache } = makeCache({ now: () => clock });
    const entry = await writeSong(cache, { frames: 800 });
    const updated = await writeDuet(cache, entry.key, 800);

    clock += 1000;
    await cache.touch(entry.key);
    clock += 1000;
    await cache.markPlayed(entry.key);

    const stored = await cache.cachedEntry(entry.key);
    expect(stored?.lastUsedAt).toBe(NOW + 2000);
    expect(stored?.playCount).toBe(1);
    expect(stored?.bytes).toBe(updated.bytes);
    expect(stored?.duet?.helperVersion).toBe('helper-1');
    expect(await cache.hasCachedDuet(entry.key)).toBe(true);
  });

  it('removes only the duet sidecar and gives the stem bytes back', async () => {
    const { cache, files, metadata } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });
    const withDuet = await writeDuet(cache, entry.key, 1000);

    await cache.removeCachedDuet(entry.key);

    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.readCachedDuet(entry.key)).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    expect((await cache.readCachedStems(entry.key))?.frames).toBe(1000);
    expect(files.entries.has(entry.key)).toBe(true);
    expect(files.entries.get(entry.key)?.duet).toBeNull();
    const stored = metadata.entries()[0];
    expect(stored?.bytes).toBe(entry.bytes);
    expect(stored?.duet).toBeUndefined();
    expect(withDuet.bytes).toBeGreaterThan(entry.bytes);
    expect((await cache.usage()).bytes).toBe(entry.bytes);
  });

  it('cleans a partial duet write without hiding the stems', async () => {
    const { cache, files } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });
    const stored = files.entries.get(entry.key);
    if (stored === undefined) {
      throw new Error('expected a stored entry');
    }
    stored.duet = {
      voice1: new Uint8Array([1, 2, 3]),
      voice2: new Uint8Array([4, 5, 6]),
      map: '{}',
      partial: true,
    };

    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.readCachedDuet(entry.key)).toBeNull();

    expect(await cache.cleanupInterruptedWrites()).toBe(0);
    expect(files.entries.get(entry.key)?.duet).toBeNull();
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
  });

  it('cleans up after a duet write that fails twice', async () => {
    const { cache, files, metadata } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });
    files.duetFailures = 2;

    await expect(writeDuet(cache, entry.key, 1000)).rejects.toThrow();

    expect(files.entries.get(entry.key)?.duet).toBeNull();
    expect(metadata.entries()[0]?.duet).toBeUndefined();
    expect(metadata.entries()[0]?.bytes).toBe(entry.bytes);
    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    expect((await cache.usage()).bytes).toBe(entry.bytes);
  });
});

describe('duet accounting and eviction', () => {
  it('counts the sidecar in the entry, usage and the per-entry cap', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, { frames: 2000 });
    const usageBefore = await cache.usage();
    const withDuet = await writeDuet(cache, entry.key, 2000);
    const usageAfter = await cache.usage();

    expect(usageBefore.bytes).toBe(entry.bytes);
    expect(usageAfter.bytes).toBe(withDuet.bytes);
    expect(usageAfter.bytes).toBeGreaterThan(usageBefore.bytes);
    expect(usageAfter.count).toBe(1);
    expect(withDuet.duet?.bytes).toBe(withDuet.bytes - entry.bytes);
    expect(await cache.hasCachedDuet(entry.key)).toBe(true);
  });

  it('refuses a duet that would make the entry exceed its cap', async () => {
    const codec = new FakeCodec(1);
    const files = new FakeCacheFiles();
    const metadata = new FakeMetadata();
    const wide = makeCache({
      files,
      metadata,
      codec,
      maxEntryBytes: 100_000,
    });
    const entry = await writeSong(wide.cache, { frames: 500 });
    const base = await wide.cache.cachedEntry(entry.key);
    if (base === null) {
      throw new Error('expected the base entry');
    }
    // The cap fits the stems but not the sidecar.
    const tight = createStemCache({
      files,
      metadata,
      codec,
      maxEntryBytes: base.bytes + 100,
      limitBytes: CACHE_LIMIT_BYTES,
      ttlMs: CACHE_TTL_MS,
      now: () => NOW,
    });

    await expect(writeDuet(tight, entry.key, 500)).rejects.toThrow(
      /per-entry/u,
    );
    expect(await tight.hasCachedDuet(entry.key)).toBe(false);
    expect(await tight.hasCachedStems(entry.key)).toBe(true);
  });

  it('evicts an entry with its sidecar and frees all of its bytes', async () => {
    const first = await writeSong(
      makeCache().cache,
      { videoId: 'video-00001', frames: 1000 },
    );
    const second = await writeSong(
      makeCache().cache,
      { videoId: 'video-00002', frames: 1000 },
    );
    const metadata = new FakeMetadata([first, second]);
    const files = new FakeCacheFiles();
    files.seed(first.key);
    files.seed(second.key);
    const { cache } = makeCache({ metadata, files });
    const withDuet = await writeDuet(cache, first.key, 1000);

    const freed = await cache.evictUntilUnder(withDuet.bytes + second.bytes - 1);

    expect(freed).toBe(withDuet.bytes);
    expect(files.entries.has(first.key)).toBe(false);
    expect(files.entries.has(second.key)).toBe(true);
    expect(await cache.hasCachedStems(first.key)).toBe(false);
    expect(await cache.hasCachedDuet(first.key)).toBe(false);
    expect((await cache.usage()).bytes).toBe(second.bytes);
  });

  it('prunes an expired entry together with its duet sidecar', async () => {
    const old = seedEntry('video-00001', {
      lastUsedAt: NOW - 91 * 24 * 60 * 60 * 1000,
    });
    const metadata = new FakeMetadata([old]);
    const files = new FakeCacheFiles();
    files.seed(old.key);
    const { cache } = makeCache({
      metadata,
      files,
      now: () => NOW - 100 * 24 * 60 * 60 * 1000,
    });
    await writeDuet(cache, old.key, old.durationFrames);

    expect(await cache.prune(NOW)).toBe(1);
    expect(files.entries.has(old.key)).toBe(false);
    expect(metadata.entries()).toEqual([]);
  });

  it('clears every duet sidecar along with the stems', async () => {
    const { cache, files } = makeCache();
    const entry = await writeSong(cache, { frames: 1000 });
    await writeDuet(cache, entry.key, 1000);

    await cache.clearCache();

    expect(files.entries.size).toBe(0);
    expect(await cache.hasCachedStems(entry.key)).toBe(false);
    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(await cache.usage()).toEqual({
      bytes: 0,
      count: 0,
      limitBytes: CACHE_LIMIT_BYTES,
    });
  });

  it('drops a stale sidecar on startup instead of the stems', async () => {
    const entry = seedEntry('video-00001');
    const metadata = new FakeMetadata([
      {
        ...entry,
        bytes: entry.bytes + 500,
        duet: {
          bytes: 500,
          frames: entry.durationFrames,
          sampleRate: entry.sampleRate,
          duetFormatVersion: DUET_FORMAT_VERSION,
          helperVersion: 'helper-1',
        },
      },
    ]);
    const files = new FakeCacheFiles();
    files.seed(entry.key);

    const { cache } = makeCache({ metadata, files });
    const removed = await cache.cleanupInterruptedWrites();

    expect(removed).toBe(0);
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
    expect(await cache.hasCachedDuet(entry.key)).toBe(false);
    expect(metadata.entries()[0]?.bytes).toBe(entry.bytes);
    expect(metadata.entries()[0]?.duet).toBeUndefined();
  });
});

describe('duet compatibility', () => {
  it('does not bump the global stem format or key', async () => {
    const { cache } = makeCache();
    const entry = await writeSong(cache, {
      frames: 1000,
      formatVersion: CACHE_FORMAT_VERSION,
    });
    const updated = await writeDuet(cache, entry.key, 1000);

    expect(CACHE_FORMAT_VERSION).toBe(2);
    expect(DUET_FORMAT_VERSION).toBe(1);
    expect(updated.formatVersion).toBe(CACHE_FORMAT_VERSION);
    expect(updated.key).toBe(entry.key);
    expect(entry.key).toBe(
      cacheKey('video-00001', CACHE_FORMAT_VERSION, 'model', 44100, 1000),
    );
    expect(await cache.hasCachedStems(entry.key)).toBe(true);
  });
});
