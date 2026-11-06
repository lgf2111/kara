import { describe, expect, it } from 'vitest';

import {
  CACHE_FORMAT_VERSION,
  CACHE_METADATA_VERSION,
  cacheKey,
  normaliseCacheMetadata,
  normaliseCachedEntry,
} from '../src/cache/entry.ts';
import { seedEntry } from './cache-fakes.ts';

describe('cacheKey', () => {
  it('changes for every input that can change the audio', () => {
    const base = cacheKey('abcdefghijk', 1, 'htdemucs-web', 44100, 10_584_000);
    expect(base).toBe(
      cacheKey('abcdefghijk', 1, 'htdemucs-web', 44100, 10_584_000),
    );
    expect(cacheKey('different00', 1, 'htdemucs-web', 44100, 10_584_000)).not.toBe(
      base,
    );
    expect(cacheKey('abcdefghijk', 2, 'htdemucs-web', 44100, 10_584_000)).not.toBe(
      base,
    );
    expect(cacheKey('abcdefghijk', 1, 'htdemucs-web-v2', 44100, 10_584_000)).not.toBe(
      base,
    );
    expect(cacheKey('abcdefghijk', 1, 'htdemucs-web', 48000, 10_584_000)).not.toBe(
      base,
    );
    expect(cacheKey('abcdefghijk', 1, 'htdemucs-web', 44100, 10_583_999)).not.toBe(
      base,
    );
  });

  it('escapes separators so two different entries cannot share a key', () => {
    expect(cacheKey('a/b', 1, 'm', 44100, 100)).not.toBe(
      cacheKey('a', 1, 'b/m', 44100, 100),
    );
  });
});

describe('normaliseCachedEntry', () => {
  it('reads a complete record back, trimming the words', () => {
    const entry = seedEntry('abcdefghijk');
    const parsed = normaliseCachedEntry({
      ...entry,
      title: '  A\nSong  ',
      artist: '  An   Artist ',
    });

    expect(parsed?.title).toBe('A Song');
    expect(parsed?.artist).toBe('An Artist');
    expect(parsed).toEqual(
      seedEntry('abcdefghijk', { title: 'A Song', artist: 'An Artist' }),
    );
  });

  it('accepts one timestamp when the other is missing', () => {
    const entry = seedEntry('abcdefghijk');
    const parsed = normaliseCachedEntry({
      ...entry,
      createdAt: undefined,
    });

    expect(parsed?.createdAt).toBe(entry.lastUsedAt);
    expect(parsed?.lastUsedAt).toBe(entry.lastUsedAt);
  });

  it('drops a record that is not complete', () => {
    const entry = seedEntry('abcdefghijk');
    expect(normaliseCachedEntry({ ...entry, complete: false })).toBeNull();
    expect(normaliseCachedEntry({ ...entry, complete: undefined })).toBeNull();
  });

  it('drops a record whose fields no longer name its key', () => {
    const entry = seedEntry('abcdefghijk');
    expect(normaliseCachedEntry({ ...entry, modelVersion: 'another-model' })).toBeNull();
    expect(normaliseCachedEntry({ ...entry, durationFrames: 999 })).toBeNull();
    expect(normaliseCachedEntry({ ...entry, sampleRate: 48000 })).toBeNull();
  });

  it('drops records with impossible sizes or times', () => {
    const entry = seedEntry('abcdefghijk');
    expect(normaliseCachedEntry({ ...entry, bytes: 0 })).toBeNull();
    expect(normaliseCachedEntry({ ...entry, bytes: -1 })).toBeNull();
    expect(normaliseCachedEntry({ ...entry, playCount: -1 })).toBeNull();
    expect(
      normaliseCachedEntry({ ...entry, createdAt: null, lastUsedAt: null }),
    ).toBeNull();
    expect(normaliseCachedEntry({ ...entry, durationFrames: 0 })).toBeNull();
    expect(normaliseCachedEntry({ ...entry, sampleRate: 1 })).toBeNull();
  });

  it('reads an ISO date as well as epoch milliseconds', () => {
    const entry = seedEntry('abcdefghijk');
    const parsed = normaliseCachedEntry({
      ...entry,
      createdAt: '2026-11-06T12:00:00.000Z',
      lastUsedAt: '2026-11-07T12:00:00.000Z',
    });

    expect(parsed?.createdAt).toBe(Date.UTC(2026, 10, 6, 12));
    expect(parsed?.lastUsedAt).toBe(Date.UTC(2026, 10, 7, 12));
  });

  it('keeps the cached song facts and guide melody', () => {
    const entry = seedEntry('abcdefghijk', { formatVersion: CACHE_FORMAT_VERSION });
    const analysis = {
      key: { tonic: 7, mode: 'major' as const, confidence: 0.8 },
      bpm: 128,
      bpmConfidence: 0.7,
      range: { lowMidi: 48, highMidi: 76, confidence: 0.6, frames: 120 },
    };
    const practiceNotes = [
      { start: 0.2, end: 0.8, midi: 67, confidence: 0.9 },
    ];

    const parsed = normaliseCachedEntry({ ...entry, analysis, practiceNotes });

    expect(parsed?.analysis).toEqual(analysis);
    expect(parsed?.practiceNotes).toEqual(practiceNotes);
  });

  it('drops malformed extras but keeps the audio entry', () => {
    const entry = seedEntry('abcdefghijk');

    const parsed = normaliseCachedEntry({
      ...entry,
      analysis: 'not an object',
      practiceNotes: 'not a list',
    });

    expect(parsed).toEqual(entry);
    expect(parsed?.analysis).toBeUndefined();
    expect(parsed?.practiceNotes).toBeUndefined();
  });
});

describe('normaliseCacheMetadata', () => {
  it('reads the versioned document', () => {
    const entry = seedEntry('abcdefghijk');
    expect(
      normaliseCacheMetadata({
        version: CACHE_METADATA_VERSION,
        entries: [entry],
      }),
    ).toEqual([entry]);
  });

  it('reads a plain array, which is the shape before the version wrapper', () => {
    const entry = seedEntry('abcdefghijk');
    expect(normaliseCacheMetadata([entry])).toEqual([entry]);
  });

  it('returns an empty list for a missing, malformed or future document', () => {
    expect(normaliseCacheMetadata(null)).toEqual([]);
    expect(normaliseCacheMetadata('nonsense')).toEqual([]);
    expect(normaliseCacheMetadata({ version: 99, entries: [] })).toEqual([]);
    expect(normaliseCacheMetadata({ version: CACHE_METADATA_VERSION })).toEqual([]);
    expect(normaliseCacheMetadata({ version: CACHE_METADATA_VERSION, entries: 'x' })).toEqual(
      [],
    );
  });

  it('drops malformed records and keeps the rest', () => {
    const good = seedEntry('abcdefghijk');
    const bad = seedEntry('lmnopqrstuv');
    const parsed = normaliseCacheMetadata({
      version: CACHE_METADATA_VERSION,
      entries: [null, { ...bad, complete: false }, good, 17],
    });

    expect(parsed).toEqual([good]);
  });

  it('keeps the most recently used duplicate', () => {
    const older = seedEntry('abcdefghijk', {
      lastUsedAt: 1_700_000_000_000,
      playCount: 9,
      bytes: 1,
    });
    const newer = seedEntry('abcdefghijk', {
      lastUsedAt: 1_700_000_100_000,
      playCount: 1,
      bytes: 2,
    });

    expect(normaliseCacheMetadata([older, newer])).toEqual([newer]);
    expect(normaliseCacheMetadata([newer, older])).toEqual([newer]);
  });
});
