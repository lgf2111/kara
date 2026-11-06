import { describe, expect, it } from 'vitest';

import {
  CACHE_LIMIT_BYTES,
  CACHE_METADATA_VERSION,
  CACHE_TTL_MS,
  normaliseCacheMetadata,
} from '../src/cache/entry.ts';
import {
  createIndexFileStore,
  createOpfsCacheMetadata,
  type IndexDirectory,
} from '../src/cache/metadata-opfs.ts';
import { createStemCache } from '../src/cache/store.ts';
import {
  FakeCacheFiles,
  FakeCodec,
  seedEntry,
  writeSong,
} from './cache-fakes.ts';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * The four file operations, in memory. `move` can be switched off to exercise
 * the fallback for a platform without `FileSystemFileHandle.move`.
 */
class FakeIndexDirectory implements IndexDirectory {
  readonly files = new Map<string, string>();
  moveSupported = true;
  moves = 0;
  writes = 0;

  readText(name: string): Promise<string | null> {
    return Promise.resolve(this.files.get(name) ?? null);
  }

  writeText(name: string, text: string): Promise<void> {
    this.writes += 1;
    this.files.set(name, text);
    return Promise.resolve();
  }

  move(from: string, to: string): Promise<boolean> {
    if (!this.moveSupported) {
      return Promise.resolve(false);
    }
    const text = this.files.get(from);
    if (text === undefined) {
      return Promise.resolve(false);
    }
    this.moves += 1;
    this.files.delete(from);
    this.files.set(to, text);
    return Promise.resolve(true);
  }

  remove(name: string): Promise<void> {
    this.files.delete(name);
    return Promise.resolve();
  }
}

function document(entries: unknown): string {
  return JSON.stringify({ version: CACHE_METADATA_VERSION, entries });
}

describe('the OPFS JSON index', () => {
  it('round-trips the records it is given', async () => {
    const directory = new FakeIndexDirectory();
    const metadata = createOpfsCacheMetadata({ directory });
    const entries = [seedEntry('video-00001'), seedEntry('video-00002')];

    await metadata.write(entries);

    expect(normaliseCacheMetadata(await metadata.read())).toEqual(entries);
    expect(directory.files.has('index.json')).toBe(true);
    expect(directory.files.has('index.json.tmp')).toBe(false);
  });

  it('commits with a move rather than editing the live file', async () => {
    const directory = new FakeIndexDirectory();
    const metadata = createOpfsCacheMetadata({ directory });

    await metadata.write([seedEntry('video-00001')]);

    expect(directory.moves).toBe(1);
    expect(directory.files.get('index.json')).toBe(
      document([seedEntry('video-00001')]),
    );
  });

  it('recovers a complete temp file left by an interrupted commit', async () => {
    const directory = new FakeIndexDirectory();
    const metadata = createOpfsCacheMetadata({ directory });
    directory.files.set(
      'index.json.tmp',
      document([seedEntry('video-00001')]),
    );

    const recovered = await metadata.read();

    expect(normaliseCacheMetadata(recovered).map((entry) => entry.videoId)).toEqual([
      'video-00001',
    ]);
    expect(directory.files.has('index.json')).toBe(true);
    expect(directory.files.has('index.json.tmp')).toBe(false);
  });

  it('prefers the temp file when the main one is corrupt', async () => {
    const directory = new FakeIndexDirectory();
    const metadata = createOpfsCacheMetadata({ directory });
    directory.files.set('index.json', '{not json');
    directory.files.set(
      'index.json.tmp',
      document([seedEntry('video-00001')]),
    );

    expect(
      normaliseCacheMetadata(await metadata.read()).map((entry) => entry.videoId),
    ).toEqual(['video-00001']);
  });

  it('falls back to a direct write when the platform cannot move', async () => {
    const directory = new FakeIndexDirectory();
    directory.moveSupported = false;
    const interoperability = createIndexFileStore(directory);

    await interoperability.write(document([seedEntry('video-00001')]));

    expect(directory.files.has('index.json')).toBe(true);
    expect(directory.files.has('index.json.tmp')).toBe(false);
  });

  it('returns null for a missing index and an empty list through the store', async () => {
    const directory = new FakeIndexDirectory();
    const metadata = createOpfsCacheMetadata({ directory });

    expect(await metadata.read()).toBeNull();
    expect(normaliseCacheMetadata(await metadata.read())).toEqual([]);
  });

  it('serialises two writes from one context', async () => {
    const directory = new FakeIndexDirectory();
    const metadata = createOpfsCacheMetadata({ directory });
    const first = seedEntry('video-00001');
    const second = seedEntry('video-00002');

    await Promise.all([metadata.write([first]), metadata.write([second])]);

    expect(
      normaliseCacheMetadata(await metadata.read()).map((entry) => entry.videoId),
    ).toEqual(['video-00002']);
  });
});

describe('the store over the OPFS index', () => {
  function makeCache(directory: FakeIndexDirectory) {
    const metadata = createOpfsCacheMetadata({ directory });
    const cache = createStemCache({
      files: new FakeCacheFiles(),
      metadata,
      codec: new FakeCodec(),
      now: () => NOW,
      limitBytes: CACHE_LIMIT_BYTES,
      ttlMs: CACHE_TTL_MS,
    });
    return { cache, metadata };
  }

  it('counts usage, prunes by TTL and evicts through the new adapter', async () => {
    const directory = new FakeIndexDirectory();
    const { cache, metadata } = makeCache(directory);
    const entry = await writeSong(cache, { videoId: 'video-00001', frames: 1000 });

    expect(await cache.usage()).toEqual({
      bytes: entry.bytes,
      count: 1,
      limitBytes: CACHE_LIMIT_BYTES,
    });

    const old = seedEntry('video-00002', {
      bytes: 100,
      lastUsedAt: NOW - 91 * DAY,
      createdAt: NOW - 100 * DAY,
    });
    await metadata.write([...normaliseCacheMetadata(await metadata.read()), old]);

    expect(await cache.prune(NOW)).toBe(1);
    expect((await cache.usage()).count).toBe(1);

    await cache.evictUntilUnder(0);
    expect((await cache.usage()).count).toBe(0);
    expect(directory.files.has('index.json')).toBe(true);
  });
});
