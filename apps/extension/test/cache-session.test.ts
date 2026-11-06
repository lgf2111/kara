import { describe, expect, it } from 'vitest';

import type { PracticeNote } from '../src/audio/practice.ts';
import type { SongFacts } from '../src/audio/song-analysis.ts';
import { STEMS, type Stem } from '../src/audio/stems.ts';
import {
  CACHE_FORMAT_VERSION,
  cacheKey,
  type CachedEntry,
  type CachedStems,
  type StereoChannels,
} from '../src/cache/entry.ts';
import {
  DUET_FORMAT_VERSION,
  duetVoicePair,
  type CachedDuet,
  type CachedDuetInput,
  type DuetExpectation,
} from '../src/cache/duet.ts';
import type { StemWriter } from '../src/cache/store.ts';
import {
  StemCacheSession,
  type StemCacheStore,
} from '../src/offscreen/stem-cache-session.ts';
import { seedEntry } from './cache-fakes.ts';

const VIDEO = 'abcdefghijk';
const MODEL = 'htdemucs-web';
const RATE = 44100;
const FACTS: SongFacts = {
  key: { tonic: 7, mode: 'major', confidence: 0.8 },
  bpm: 128,
  bpmConfidence: 0.7,
  range: { lowMidi: 48, highMidi: 76, confidence: 0.6, frames: 120 },
};
const NOTES: readonly PracticeNote[] = [
  { start: 0.2, end: 0.8, midi: 67, confidence: 0.9 },
];

function channels(frames: number, offset = 0): Float32Array[] {
  return Array.from({ length: STEMS.length * 2 }, (_, index) => {
    const channel = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      channel[frame] = (offset + frame + index) / 100_000;
    }
    return channel;
  });
}

function cachedStems(entry: CachedEntry): CachedStems {
  const stems = {} as Record<Stem, StereoChannels>;
  for (const [index, stem] of STEMS.entries()) {
    const left = new Float32Array(entry.durationFrames);
    const right = new Float32Array(entry.durationFrames);
    for (let frame = 0; frame < entry.durationFrames; frame += 1) {
      left[frame] = (frame + index) / 100_000;
      right[frame] = -(frame + index) / 100_000;
    }
    stems[stem] = { left, right };
  }
  return {
    key: entry.key,
    sampleRate: entry.sampleRate,
    frames: entry.durationFrames,
    stems,
  };
}

class RecordingWriter implements StemWriter {
  readonly blocks: Array<{
    readonly stem: Stem;
    readonly startSample: number;
    readonly left: Float32Array;
    readonly right: Float32Array;
  }> = [];
  aborted = false;
  finished = false;
  failAppend = false;
  failFinish = false;

  constructor(private readonly entry: CachedEntry) {}

  append(
    stem: Stem,
    startSample: number,
    left: Float32Array,
    right: Float32Array,
  ): Promise<void> {
    if (this.failAppend) {
      return Promise.reject(new Error('the encoder failed'));
    }
    this.blocks.push({
      stem,
      startSample,
      left: left.slice(),
      right: right.slice(),
    });
    return Promise.resolve();
  }

  finish(): Promise<CachedEntry> {
    if (this.failFinish) {
      return Promise.reject(new Error('the disk is full'));
    }
    this.finished = true;
    return Promise.resolve(this.entry);
  }

  abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }
}

class FakeStore implements StemCacheStore {
  entry: CachedEntry | null = null;
  stems: CachedStems | null = null;
  writer: RecordingWriter | null = null;
  writerOptions: Parameters<StemCacheStore['createStemWriter']>[0] | null = null;
  failCreate = false;
  findCalls = 0;
  readCalls = 0;
  readonly analyses: Array<{ readonly key: string; readonly facts: SongFacts }> = [];
  readonly notes: Array<{
    readonly key: string;
    readonly notes: readonly PracticeNote[];
  }> = [];
  readonly played: string[] = [];
  readonly conflicts: Array<{
    readonly videoId: string;
    readonly keepKey: string;
  }> = [];
  duet: CachedDuet | null = null;
  duetWriteFails = false;
  duetReads = 0;
  readonly duetExpectations: Array<DuetExpectation | undefined> = [];
  readonly duetWrites: Array<{ readonly key: string; readonly input: CachedDuetInput }> =
    [];

  findEntry(): Promise<CachedEntry | null> {
    this.findCalls += 1;
    return Promise.resolve(this.entry);
  }

  readCachedStems(): Promise<CachedStems | null> {
    this.readCalls += 1;
    return Promise.resolve(this.stems);
  }

  createStemWriter(
    options: Parameters<StemCacheStore['createStemWriter']>[0],
  ): Promise<StemWriter> {
    this.writerOptions = options;
    if (this.failCreate) {
      return Promise.reject(new Error('the cache is unavailable'));
    }
    const entry = seedEntry(options.videoId, {
      formatVersion: options.formatVersion,
      modelVersion: options.modelVersion,
      sampleRate: options.sampleRate,
      durationFrames: options.durationFrames,
      bytes: 4096,
    });
    this.writer = new RecordingWriter(entry);
    return Promise.resolve(this.writer);
  }

  saveAnalysis(key: string, facts: SongFacts): Promise<boolean> {
    this.analyses.push({ key, facts });
    return Promise.resolve(true);
  }

  savePracticeNotes(key: string, notes: readonly PracticeNote[]): Promise<boolean> {
    this.notes.push({ key, notes });
    return Promise.resolve(true);
  }

  markPlayed(key: string): Promise<void> {
    this.played.push(key);
    return Promise.resolve();
  }

  removeConflicts(
    query: Parameters<StemCacheStore['removeConflicts']>[0],
    keepKey: string,
  ): Promise<number> {
    this.conflicts.push({ videoId: query.videoId, keepKey });
    return Promise.resolve(0);
  }

  hasCachedDuet(
    _key: string,
    expectation?: DuetExpectation,
  ): Promise<boolean> {
    this.duetExpectations.push(expectation);
    return Promise.resolve(this.duet !== null);
  }

  readCachedDuet(
    _key: string,
    expectation?: DuetExpectation,
  ): Promise<CachedDuet | null> {
    this.duetReads += 1;
    this.duetExpectations.push(expectation);
    return Promise.resolve(this.duet);
  }

  writeCachedDuet(key: string, input: CachedDuetInput): Promise<CachedEntry> {
    this.duetWrites.push({ key, input });
    if (this.duetWriteFails || this.entry === null) {
      return Promise.reject(new Error('the duet could not be saved'));
    }
    return Promise.resolve(this.entry);
  }
}

function session(store: FakeStore): StemCacheSession {
  return new StemCacheSession({
    cache: store,
    videoId: VIDEO,
    modelVersion: MODEL,
    sampleRate: RATE,
    title: '',
    artist: '',
    onStatus: () => undefined,
  });
}

describe('a cache hit', () => {
  it('returns the exact frames, touches nothing and starts no writer', async () => {
    const store = new FakeStore();
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      modelVersion: MODEL,
      sampleRate: RATE,
      durationFrames: 1234,
      bytes: 55_000,
      analysis: FACTS,
      practiceNotes: NOTES,
    });
    store.entry = entry;
    store.stems = cachedStems(entry);
    const cache = session(store);

    const started = await cache.start();

    expect(started.kind).toBe('hit');
    if (started.kind !== 'hit') {
      throw new Error('expected a hit');
    }
    expect(started.stems.frames).toBe(1234);
    expect(started.stems.stems.vocals.left.length).toBe(1234);
    expect(started.entry.analysis).toEqual(FACTS);
    expect(started.entry.practiceNotes).toEqual(NOTES);
    expect(store.findCalls).toBe(1);
    expect(store.readCalls).toBe(1);
    expect(store.writerOptions).toBeNull();
    expect(cache.status()).toEqual({
      state: 'hit',
      bytes: 55_000,
      detail: 'Loaded from cache.',
    });

    await cache.markPlayed();
    expect(store.played).toEqual([entry.key]);
  });

  it('writes extras straight to the existing entry', async () => {
    const store = new FakeStore();
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: 10,
      analysis: FACTS,
    });
    store.entry = entry;
    store.stems = cachedStems(entry);
    const cache = session(store);

    await cache.start();
    await cache.saveAnalysis(FACTS);
    await cache.savePracticeNotes(NOTES);

    expect(store.analyses).toEqual([{ key: entry.key, facts: FACTS }]);
    expect(store.notes).toEqual([{ key: entry.key, notes: NOTES }]);
  });
});

describe('a cache miss', () => {
  it('writes every block in order and finishes after the last one', async () => {
    const store = new FakeStore();
    const cache = session(store);

    const started = await cache.start();
    expect(started.kind).toBe('miss');
    expect(cache.status().state).toBe('miss');

    cache.beginWrite(1000);
    const expectedKey = cacheKey(VIDEO, CACHE_FORMAT_VERSION, MODEL, RATE, 1000);
    expect(store.writerOptions?.key).toBe(expectedKey);
    expect(cache.entryKey()).toBe(expectedKey);
    expect(cache.status().state).toBe('writing');

    const first = channels(400);
    cache.appendBlock(0, first);
    // The writer owns a copy, so mutating the player's block afterwards cannot
    // change what the cache encodes.
    first[4]?.fill(9);
    cache.appendBlock(400, channels(600, 400));
    void cache.saveAnalysis(FACTS);

    const finished = await cache.finish();

    expect(finished?.key).toBe(expectedKey);
    expect(store.writer?.finished).toBe(true);
    expect(store.writer?.blocks).toHaveLength(STEMS.length * 2);
    expect(store.writer?.blocks[0]?.stem).toBe('drums');
    expect(store.writer?.blocks[0]?.startSample).toBe(0);
    expect(store.writer?.blocks[0]?.left[0]).toBeCloseTo(0, 6);
    expect(store.writer?.blocks[4]?.startSample).toBe(400);
    expect(cache.status()).toEqual({
      state: 'ready',
      bytes: 4096,
      detail: null,
    });
    expect(store.analyses).toEqual([{ key: expectedKey, facts: FACTS }]);
    expect(store.played).toEqual([expectedKey]);
    expect(store.conflicts).toEqual([{ videoId: VIDEO, keepKey: expectedKey }]);
  });

  it('keeps a write failure out of the session', async () => {
    const store = new FakeStore();
    const cache = session(store);
    await cache.start();
    cache.beginWrite(100);
    if (store.writer === null) {
      throw new Error('expected a writer');
    }
    store.writer.failAppend = true;
    cache.appendBlock(0, channels(100));

    const finished = await cache.finish();

    expect(finished).toBeNull();
    expect(cache.status().state).toBe('error');
    expect(store.writer.aborted).toBe(true);
    // Still safe to call after the failure.
    cache.appendBlock(0, channels(100));
    await expect(cache.finish()).resolves.toBeNull();
  });

  it('turns a writer that cannot start into a status, not a throw', async () => {
    const store = new FakeStore();
    store.failCreate = true;
    const cache = session(store);
    await cache.start();
    cache.beginWrite(100);

    await expect(cache.finish()).resolves.toBeNull();
    expect(cache.status().state).toBe('error');
    expect(cache.status().detail).toContain('could not start');
  });

  it('aborts an unfinished entry without touching a finished one', async () => {
    const store = new FakeStore();
    const cache = session(store);
    await cache.start();
    cache.beginWrite(100);
    cache.appendBlock(0, channels(100));
    await cache.abort();

    expect(store.writer?.aborted).toBe(true);

    const second = new FakeStore();
    const finished = session(second);
    await finished.start();
    finished.beginWrite(100);
    finished.appendBlock(0, channels(100));
    const entry = await finished.finish();
    await finished.abort();

    expect(entry).not.toBeNull();
    expect(second.writer?.aborted).toBe(false);
  });
});

describe('the duet sidecar through a session', () => {
  function duet(entry: CachedEntry): CachedDuet {
    const voice1 = new Float32Array(entry.durationFrames);
    const voice2 = new Float32Array(entry.durationFrames);
    const voices = duetVoicePair(voice1, voice2);
    return {
      key: entry.key,
      sampleRate: entry.sampleRate,
      frames: entry.durationFrames,
      voices,
      voice1,
      voice2,
      map: { anchors: [] },
      quality: { lowConfidence: 4.5 },
      anchors: [],
      helperVersion: 'helper-1',
      modelVersion: null,
      duetFormatVersion: DUET_FORMAT_VERSION,
    };
  }

  it('reads a cached pair from the entry the session already has', async () => {
    const store = new FakeStore();
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: 40,
    });
    store.entry = entry;
    store.stems = cachedStems(entry);
    store.duet = duet(entry);
    const cache = session(store);

    await cache.start();
    const pair = await cache.readCachedDuet();

    expect(pair?.key).toBe(entry.key);
    expect(pair?.frames).toBe(40);
    expect(store.duetReads).toBe(1);
    expect(store.duetExpectations[0]).toMatchObject({
      helperVersion: expect.any(String),
      duetFormatVersion: DUET_FORMAT_VERSION,
    });
  });

  it('does not look for a pair when the song has no complete entry', async () => {
    const store = new FakeStore();
    const cache = session(store);
    await cache.start();

    expect(await cache.duetEntryKey()).toBeNull();
    expect(await cache.readCachedDuet()).toBeNull();
    expect(store.duetReads).toBe(0);
  });

  it('writes the helper result and keeps a cache failure out of the pair', async () => {
    const store = new FakeStore();
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: 40,
    });
    store.entry = entry;
    store.stems = cachedStems(entry);
    const cache = session(store);
    await cache.start();

    const voice1 = new Float32Array(40);
    const voice2 = new Float32Array(40);
    const map = { anchors: [{ voice: 1, start: 1, end: 2 }] };
    expect(await cache.writeCachedDuet([voice1, voice2], map)).toBe(true);
    expect(store.duetWrites).toEqual([
      {
        key: entry.key,
        input: {
          voices: [voice1, voice2],
          map,
          helperVersion: expect.any(String),
          duetFormatVersion: DUET_FORMAT_VERSION,
        },
      },
    ]);

    store.duetWriteFails = true;
    expect(await cache.writeCachedDuet([voice1, voice2], map)).toBe(false);
  });
});
