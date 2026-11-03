import { describe, expect, it } from 'vitest';

import { createMemorySongStore, type SongRecord } from '../src/library/songs.ts';
import {
  deleteSong,
  songBytes,
  songSizes,
  sourcePathFor,
  totalBytes,
} from '../src/library/storage.ts';
import { createMemoryStore, type Store } from '../src/storage/store.ts';

function song(id: string, overrides: Partial<SongRecord> = {}): SongRecord {
  return {
    id,
    title: id,
    durationMs: 1000,
    sourceBytes: 2048,
    sourceKind: 'audio',
    status: 'ready',
    stemsDirectory: `songs/${id}`,
    sourcePath: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

/** A song's directory as the worker leaves it: stems, tails and job state. */
async function fillSong(store: Store, id: string, frames: number): Promise<void> {
  for (const name of ['vocals', 'instrumental']) {
    await store.writeFloat32(`songs/${id}/${name}.f32`, new Float32Array(frames * 2));
    await store.writeFloat32(`songs/${id}/tail-${name}.f32`, new Float32Array(8));
  }
  await store.writeJson(`songs/${id}/job.json`, { jobId: id });
}

describe('sourcePathFor', () => {
  it('keeps the extension, lowercased, so the browser can type the file', () => {
    expect(sourcePathFor('songs/x', 'Clip.MP4')).toBe('songs/x/source.mp4');
  });

  it('copes with a name that has no extension', () => {
    expect(sourcePathFor('songs/x', 'clip')).toBe('songs/x/source');
  });

  it('ignores dots inside the name', () => {
    expect(sourcePathFor('songs/x', 'take.2.mov')).toBe('songs/x/source.mov');
  });
});

describe('songBytes', () => {
  it('counts everything in the song directory', async () => {
    const store = createMemoryStore();
    await fillSong(store, 'a', 100);

    // Two stems of 800 bytes, two tails of 32 bytes, and the job state.
    const stateBytes = (await store.sizeOf('songs/a/job.json')) ?? 0;
    expect(stateBytes).toBeGreaterThan(0);
    expect(await songBytes(store, song('a'))).toBe(1664 + stateBytes);
  });

  it('counts a kept video source too', async () => {
    const store = createMemoryStore();
    await fillSong(store, 'a', 10);
    const before = await songBytes(store, song('a'));
    await store.writeBlob('songs/a/source.mp4', new Blob([new Uint8Array(500)]));

    const after = await songBytes(
      store,
      song('a', { sourceKind: 'video', sourcePath: 'songs/a/source.mp4' }),
    );

    expect(after - before).toBe(500);
  });

  it('is nothing for a song whose bytes are gone', async () => {
    expect(await songBytes(createMemoryStore(), song('missing'))).toBe(0);
  });
});

describe('songSizes', () => {
  it('keys a size by song id and leaves other songs out of it', async () => {
    const store = createMemoryStore();
    await fillSong(store, 'a', 10);
    await fillSong(store, 'b', 20);

    const sizes = await songSizes(store, [song('a'), song('b')]);

    expect([...sizes.keys()].sort()).toEqual(['a', 'b']);
    expect(sizes.get('b')).toBeGreaterThan(sizes.get('a') ?? 0);
    expect(totalBytes(sizes)).toBe((sizes.get('a') ?? 0) + (sizes.get('b') ?? 0));
  });

  it('totals nothing for an empty library', () => {
    expect(totalBytes(new Map())).toBe(0);
  });
});

describe('deleteSong', () => {
  it('takes the record and every byte it owns', async () => {
    const store = createMemoryStore();
    const songs = createMemorySongStore([song('a'), song('b')]);
    await fillSong(store, 'a', 10);
    await fillSong(store, 'b', 10);
    await store.writeBlob('songs/a/source.mp4', new Blob([new Uint8Array(64)]));

    await deleteSong(store, songs, song('a'));

    expect(await store.list('songs/a')).toEqual([]);
    expect(await songs.get('a')).toBeNull();
  });

  it('leaves the rest of the library alone', async () => {
    const store = createMemoryStore();
    const songs = createMemorySongStore([song('a'), song('b')]);
    await fillSong(store, 'a', 10);
    await fillSong(store, 'b', 10);

    await deleteSong(store, songs, song('a'));

    expect(await songs.list()).toHaveLength(1);
    expect(await songBytes(store, song('b'))).toBeGreaterThan(0);
  });
});
