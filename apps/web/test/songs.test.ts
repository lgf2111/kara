import { describe, expect, it } from 'vitest';

import {
  byNewest,
  createMemorySongStore,
  sourceKindFor,
  titleFromFileName,
  type SongRecord,
} from '../src/library/songs.ts';

function song(overrides: Partial<SongRecord> = {}): SongRecord {
  return {
    id: 'tone.wav-100-4410',
    title: 'tone',
    durationMs: 100,
    sourceBytes: 100,
    sourceKind: 'audio',
    status: 'ready',
    stemsDirectory: 'songs/tone.wav-100-4410',
    sourcePath: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('titleFromFileName', () => {
  it('drops the extension and tidies the rest', () => {
    expect(titleFromFileName('my_song.mp3')).toBe('my song');
    expect(titleFromFileName('  spaced   out .flac')).toBe('spaced out');
  });

  it('keeps dots that are part of the name', () => {
    expect(titleFromFileName('take.2.wav')).toBe('take.2');
  });

  it('leaves a name with no extension alone', () => {
    expect(titleFromFileName('untitled')).toBe('untitled');
  });

  it('falls back to the file name when nothing is left', () => {
    expect(titleFromFileName('.mp3')).toBe('.mp3');
  });
});

describe('sourceKindFor', () => {
  it('trusts the type the browser reports', () => {
    expect(sourceKindFor('clip.bin', 'video/mp4')).toBe('video');
    expect(sourceKindFor('clip.mp4', 'audio/mpeg')).toBe('audio');
  });

  it('falls back to the extension, whatever its case', () => {
    expect(sourceKindFor('clip.MOV')).toBe('video');
    expect(sourceKindFor('clip.webm')).toBe('video');
    expect(sourceKindFor('song.wav')).toBe('audio');
  });

  it('treats anything it cannot place as audio', () => {
    expect(sourceKindFor('song', 'application/octet-stream')).toBe('audio');
  });
});

describe('byNewest', () => {
  it('puts the most recent first and breaks ties by id', () => {
    const older = song({ id: 'a', createdAt: '2026-11-01T00:00:00.000Z' });
    const newer = song({ id: 'b', createdAt: '2026-11-02T00:00:00.000Z' });
    const sameTime = song({ id: 'c', createdAt: '2026-11-02T00:00:00.000Z' });

    expect([older, sameTime, newer].sort(byNewest).map((record) => record.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('memory song store', () => {
  it('starts empty', async () => {
    expect(await createMemorySongStore().list()).toEqual([]);
    expect(await createMemorySongStore().get('nope')).toBeNull();
  });

  it('holds a record and hands it back', async () => {
    const store = createMemorySongStore();
    const record = song();

    await store.put(record);

    expect(await store.get(record.id)).toEqual(record);
    expect(await store.list()).toEqual([record]);
  });

  it('replaces a record with the same id rather than adding another', async () => {
    const store = createMemorySongStore([song()]);

    await store.put(song({ status: 'separating' }));

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('separating');
  });

  it('lists newest first', async () => {
    const store = createMemorySongStore([
      song({ id: 'a', createdAt: '2026-11-01T00:00:00.000Z' }),
      song({ id: 'b', createdAt: '2026-11-04T00:00:00.000Z' }),
    ]);

    expect((await store.list()).map((record) => record.id)).toEqual(['b', 'a']);
  });

  it('deletes, and says nothing about a record it never had', async () => {
    const store = createMemorySongStore([song()]);

    await store.delete(song().id);
    await store.delete('never-existed');

    expect(await store.list()).toEqual([]);
  });

  it('is seeded with a copy, so later writes do not reach the caller', async () => {
    const initial = [song()];
    const store = createMemorySongStore(initial);

    await store.put(song({ id: 'other' }));

    expect(initial).toHaveLength(1);
    expect(await store.list()).toHaveLength(2);
  });
});
