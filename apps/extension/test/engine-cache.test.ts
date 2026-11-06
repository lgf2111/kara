/// <reference types="chrome" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PracticeNote } from '../src/audio/practice.ts';
import type { SongFacts } from '../src/audio/song-analysis.ts';
import { STEMS, type Stem } from '../src/audio/stems.ts';
import {
  CACHE_FORMAT_VERSION,
  type CachedEntry,
  type CachedStems,
  type StereoChannels,
} from '../src/cache/entry.ts';
import {
  DUET_FORMAT_VERSION,
  duetVoicePair,
  type CachedDuet,
} from '../src/cache/duet.ts';
import { startEngine } from '../src/offscreen/engine.ts';
import type { StemCacheStore } from '../src/offscreen/stem-cache-session.ts';
import type { StatusReport } from '../src/protocol.ts';
import { seedEntry } from './cache-fakes.ts';

vi.mock('signalsmith-stretch', () => ({
  default: async () => ({
    latency: async () => 0,
    schedule: async () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
  }),
}));

vi.mock('../src/audio/decode.ts', () => ({
  decodeStereo: async () => [new Float32Array(400), new Float32Array(400)],
}));

const duetHelper = vi.hoisted(() => ({
  constructed: 0,
  mapCalls: 0,
  anchorCalls: 0,
  revision: 0,
}));

vi.mock('../src/audio/duet-client.ts', () => ({
  DuetClient: class {
    constructor() {
      duetHelper.constructed += 1;
    }

    start(): Promise<string> {
      return Promise.resolve('job-1');
    }

    status(): Promise<{
      state: 'done';
      phase: 'calibrating';
      done: number;
      total: number;
      error: null;
      version: number;
    }> {
      return Promise.resolve({
        state: 'done',
        phase: 'calibrating',
        done: 1,
        total: 1,
        error: null,
        version: 1,
      });
    }

    anchor(): Promise<void> {
      duetHelper.anchorCalls += 1;
      duetHelper.revision += 1;
      return Promise.resolve();
    }

    cancel(): Promise<void> {
      return Promise.resolve();
    }

    voices(): Promise<[Float32Array, Float32Array]> {
      return Promise.resolve([new Float32Array(400), new Float32Array(400)]);
    }

    map(): Promise<{
      map: Record<string, unknown>;
      anchors: Array<{ voice: 1; start: number; end: number }>;
      quality: { lowConfidence: number };
      lowConfidenceSeconds: number;
    }> {
      duetHelper.mapCalls += 1;
      const anchors = Array.from(
        { length: duetHelper.revision + 1 },
        (_, index) => ({ voice: 1 as const, start: index + 1, end: index + 2 }),
      );
      const lowConfidence = duetHelper.revision === 0 ? 20 : 0;
      return Promise.resolve({
        map: { version: 1, anchors, quality: { lowConfidence } },
        anchors,
        quality: { lowConfidence },
        lowConfidenceSeconds: lowConfidence,
      });
    }

    lowConfidence(): Promise<number | null> {
      return Promise.resolve(null);
    }
  },
}));

const VIDEO = 'abcdefghijk';
const FRAMES = 800;
const FACTS: SongFacts = {
  key: { tonic: 7, mode: 'major', confidence: 0.8 },
  bpm: 128,
  bpmConfidence: 0.7,
  range: { lowMidi: 48, highMidi: 76, confidence: 0.6, frames: 20 },
};
const NOTES: readonly PracticeNote[] = [
  { start: 0.1, end: 0.5, midi: 67, confidence: 0.9 },
];

class FakeParam {
  value = 0;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
  setTargetAtTime(): void {}
}

class FakeGainNode {
  readonly gain = new FakeParam();
  connect(): this {
    return this;
  }
  disconnect(): void {}
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port: {
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: ((event: MessageEvent) => void) | null;
  } = { postMessage: vi.fn(), onmessage: null };

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }

  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate = 44_100;
  currentTime = 0;
  state = 'running';
  readonly destination = {};
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  readonly resume = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }

  createMediaStreamDestination(): { disconnect: () => void } {
    return { disconnect: () => undefined };
  }
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly url: string;
  readonly posted: unknown[] = [];
  private readonly listeners: Array<(event: { readonly data: unknown }) => void> = [];

  constructor(url: URL | string) {
    this.url = String(url);
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
    if (type === 'message') {
      this.listeners.push(listener);
    }
  }

  postMessage(command: unknown): void {
    this.posted.push(command);
    if (!this.url.includes('separator.worker')) {
      return;
    }
    const message = command as {
      readonly type: string;
      readonly startSample?: number;
      readonly left?: Float32Array;
      readonly right?: Float32Array;
    };
    if (message.type === 'init') {
      this.emit({ type: 'ready', backend: 'webgpu', backendReason: null, windowSamples: 100 });
      return;
    }
    if (message.type === 'chunk') {
      const frames = message.left?.length ?? 0;
      const channels = Array.from({ length: 8 }, (_, index) => {
        const channel = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame += 1) {
          channel[frame] = (frame + index) / 100_000;
        }
        return channel;
      });
      this.emit({
        type: 'block',
        startSample: message.startSample ?? 0,
        frames,
        channels,
        computeMs: 1,
      });
      return;
    }
    if (message.type === 'flush') {
      this.emit({ type: 'done' });
    }
  }

  terminate(): void {}

  private emit(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data });
    }
  }
}

class FakeWriter {
  readonly blocks: Array<{
    readonly stem: Stem;
    readonly startSample: number;
    readonly left: Float32Array;
    readonly right: Float32Array;
  }> = [];
  finished = false;
  aborted = false;
  failAppend = false;

  constructor(private readonly entry: CachedEntry) {}

  append(
    stem: Stem,
    startSample: number,
    left: Float32Array,
    right: Float32Array,
  ): Promise<void> {
    if (this.failAppend) {
      return Promise.reject(new Error('the cache disk is full'));
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
    this.finished = true;
    return Promise.resolve(this.entry);
  }

  abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }
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

function cachedDuet(entry: CachedEntry): CachedDuet {
  const quality = { solo: 1, lowConfidence: 12.5 };
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
    map: { version: 1, anchors: [], quality },
    quality,
    anchors: [],
    helperVersion: 'kara-duet/1',
    modelVersion: null,
    duetFormatVersion: DUET_FORMAT_VERSION,
  };
}

function fakeStore(
  entry: CachedEntry,
  stems: CachedStems,
  cached: CachedDuet | null = null,
): StemCacheStore {
  return {
    findEntry: vi.fn(async () => entry),
    readCachedStems: vi.fn(async () => stems),
    createStemWriter: vi.fn(async () => {
      throw new Error('a hit must not start a writer');
    }),
    saveAnalysis: vi.fn(async () => true),
    savePracticeNotes: vi.fn(async () => true),
    markPlayed: vi.fn(async () => undefined),
    removeConflicts: vi.fn(async () => 0),
    hasCachedDuet: vi.fn(async () => cached !== null),
    readCachedDuet: vi.fn(async () => cached),
    writeCachedDuet: vi.fn(async () => entry),
  };
}

function missStore(
  writer: FakeWriter,
  options: { readonly duetWriteFails?: boolean } = {},
): StemCacheStore {
  return {
    findEntry: vi.fn(async () => null),
    readCachedStems: vi.fn(async () => null),
    createStemWriter: vi.fn(async () => writer),
    saveAnalysis: vi.fn(async () => true),
    savePracticeNotes: vi.fn(async () => true),
    markPlayed: vi.fn(async () => undefined),
    removeConflicts: vi.fn(async () => 0),
    hasCachedDuet: vi.fn(async () => false),
    readCachedDuet: vi.fn(async () => null),
    writeCachedDuet: vi.fn(async () => {
      if (options.duetWriteFails === true) {
        throw new Error('the duet sidecar could not be written');
      }
      return seedEntry(VIDEO, { durationFrames: 400, bytes: 9000 });
    }),
  };
}

function engineOptions(
  store: StemCacheStore,
  status: (report: StatusReport) => void,
): Parameters<typeof startEngine>[0] {
  return {
    stream: {
      videoId: VIDEO,
      url: 'https://example.invalid/audio',
      mimeType: 'audio/mp4',
    },
    weightsBase: 'weights/',
    runtimePath: 'runtime/',
    playbackWorkletUrl: 'stem-player.js',
    pitchWorkletUrl: 'signalsmith-stretch.js',
    cache: store,
    prepareCache: async () => undefined,
    onStatus: status,
    onMetrics: () => undefined,
  };
}

describe('starting on a cached video', () => {
  beforeEach(() => {
    FakeAudioWorkletNode.instances = [];
    FakeAudioContext.instances = [];
    FakeWorker.instances = [];
    duetHelper.constructed = 0;
    duetHelper.mapCalls = 0;
    duetHelper.anchorCalls = 0;
    duetHelper.revision = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('GainNode', FakeGainNode);
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the four stems with no fetch, model or separation', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: FRAMES,
      sampleRate: 44_100,
      bytes: 20_000,
      analysis: FACTS,
      practiceNotes: NOTES,
    });
    const store = fakeStore(entry, cachedStems(entry));
    const fetchSpy = vi.fn(async () => {
      throw new Error('a cache hit must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const statuses: string[] = [];
    const analyses: SongFacts[] = [];
    const prepare = vi.fn(async () => undefined);

    const engine = await startEngine({
      stream: {
        videoId: VIDEO,
        url: 'https://example.invalid/audio',
        mimeType: 'audio/mp4',
      },
      weightsBase: 'weights/',
      runtimePath: 'runtime/',
      playbackWorkletUrl: 'stem-player.js',
      pitchWorkletUrl: 'signalsmith-stretch.js',
      cache: store,
      prepareCache: prepare,
      onStatus: (report) => {
        statuses.push(report.cache?.state ?? 'none');
      },
      onMetrics: () => undefined,
      onSongAnalysis: (report) => {
        if (report.facts !== null) {
          analyses.push(report.facts);
        }
      },
    });

    const player = FakeAudioWorkletNode.instances[0];
    if (player === undefined) {
      throw new Error('expected the player node');
    }
    const posted = player.port.postMessage.mock.calls.map(
      (call) => call[0] as { readonly type: string; readonly channels?: readonly Float32Array[] },
    );
    const stems = posted.find((message) => message.type === 'stems');
    if (stems?.channels === undefined) {
      throw new Error('expected the cached stems to be handed over');
    }

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.createStemWriter).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(posted.some((message) => message.type === 'begin')).toBe(false);
    expect(stems.channels).toHaveLength(STEMS.length * 2);
    for (const channel of stems.channels) {
      expect(channel.length).toBe(FRAMES);
    }
    expect(analyses).toEqual([FACTS]);

    const status = engine.status();
    expect(status.status).toBe('ready');
    expect(status.cache).toEqual({
      state: 'hit',
      bytes: 20_000,
      detail: 'Loaded from cache.',
    });
    expect(status.durationSeconds).toBeCloseTo(FRAMES / 44_100);
    expect(status.analyzedSeconds).toBeCloseTo(FRAMES / 44_100);
    expect(statuses).toContain('hit');
    expect(store.markPlayed).toHaveBeenCalledWith(entry.key);

    await engine.stop();
  });

  it('runs a bounded analysis on the cached stems when no Song facts were saved', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: FRAMES,
      sampleRate: 44_100,
      bytes: 20_000,
    });
    const store = fakeStore(entry, cachedStems(entry));

    const engine = await startEngine(engineOptions(store, () => undefined));

    const workers = FakeWorker.instances.map((worker) => worker.url);
    expect(workers.some((url) => url.includes('song-analysis.worker'))).toBe(true);
    expect(workers.some((url) => url.includes('separator.worker'))).toBe(false);
    const analysisWorker = FakeWorker.instances.find((worker) =>
      worker.url.includes('song-analysis.worker'),
    );
    const command = analysisWorker?.posted[0] as
      | {
          readonly type: string;
          readonly harmonic: Float32Array;
          readonly percussive: Float32Array;
          readonly vocals: Float32Array;
        }
      | undefined;
    expect(command?.type).toBe('analyze');
    expect(command?.harmonic.length).toBeGreaterThan(0);
    expect(command?.vocals.length).toBeGreaterThan(0);
    expect(engine.status().status).toBe('ready');
    expect(engine.status().cache?.state).toBe('hit');

    await engine.stop();
  });

  it('copies every separated block on a miss and becomes ready while the writer finishes', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: 400,
      bytes: 9000,
    });
    const writer = new FakeWriter(entry);
    const store = missStore(writer);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { 'content-length': '16' },
        }),
      ),
    );
    const statuses: string[] = [];

    const engine = await startEngine(
      engineOptions(store, (report) => {
        statuses.push(report.status);
      }),
    );

    expect(engine.status().status).toBe('ready');
    expect(store.findEntry).toHaveBeenCalledTimes(1);
    expect(store.readCachedStems).not.toHaveBeenCalled();
    expect(store.createStemWriter).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('preparing');
    expect(statuses).toContain('ready');

    await vi.waitFor(() => {
      expect(writer.finished).toBe(true);
    });
    await vi.waitFor(() => {
      expect(engine.status().cache?.state).toBe('ready');
    });

    expect(writer.blocks.map((block) => block.stem)).toEqual([...STEMS]);
    expect(writer.blocks[0]?.startSample).toBe(0);
    expect(engine.status().status).toBe('ready');
    expect(engine.status().cache?.bytes).toBe(9000);

    const player = FakeAudioWorkletNode.instances[0];
    if (player === undefined) {
      throw new Error('expected the player node');
    }
    const posted = player.port.postMessage.mock.calls.map(
      (call) => call[0] as { readonly type: string },
    );
    expect(posted.some((message) => message.type === 'begin')).toBe(true);
    expect(posted.filter((message) => message.type === 'stem-block')).toHaveLength(1);

    await engine.stop();
  });

  it('keeps the player ready when the cache writer fails', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: 400,
      bytes: 9000,
    });
    const writer = new FakeWriter(entry);
    writer.failAppend = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { 'content-length': '16' },
        }),
      ),
    );

    const engine = await startEngine(engineOptions(missStore(writer), () => undefined));

    expect(engine.status().status).toBe('ready');
    await vi.waitFor(() => {
      expect(engine.status().cache?.state).toBe('error');
    });
    await vi.waitFor(() => {
      expect(writer.aborted).toBe(true);
    });
    expect(engine.status().status).toBe('ready');

    await engine.stop();
  });

  it('loads a cached duet pair with no helper, token or fetch', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      durationFrames: FRAMES,
      sampleRate: 44_100,
      bytes: 20_000,
    });
    const cached = cachedDuet(entry);
    const store = fakeStore(entry, cachedStems(entry), cached);
    const fetchSpy = vi.fn(async () => {
      throw new Error('a cached duet must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const engine = await startEngine(engineOptions(store, () => undefined));
    engine.startDuet();

    await vi.waitFor(() => {
      expect(engine.status().duet?.state).toBe('ready');
    });
    const status = engine.status().duet;
    expect(status?.source).toBe('cache');
    expect(status?.hasVoices).toBe(true);
    expect(status?.lowConfidenceSeconds).toBe(12.5);
    expect(status?.detail).toBe('Loaded from cache.');
    expect(duetHelper.constructed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.writeCachedDuet).not.toHaveBeenCalled();

    const player = FakeAudioWorkletNode.instances[0];
    if (player === undefined) {
      throw new Error('expected the player node');
    }
    const posted = player.port.postMessage.mock.calls.map(
      (call) =>
        call[0] as {
          readonly type: string;
          readonly voice1?: Float32Array;
          readonly voice2?: Float32Array;
        },
    );
    const pair = posted.find((message) => message.type === 'duet');
    expect(pair?.voice1?.length).toBe(FRAMES);
    expect(pair?.voice2?.length).toBe(FRAMES);
    expect(posted.some((message) => message.type === 'duet-mix')).toBe(true);

    await engine.stop();
  });

  it('runs the helper on a miss and writes the pair and map to the entry', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      modelVersion: 'htdemucs-web',
      durationFrames: 400,
      bytes: 9000,
    });
    const writer = new FakeWriter(entry);
    const store = missStore(writer);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { 'content-length': '16' },
        }),
      ),
    );
    const engine = await startEngine({
      ...engineOptions(store, () => undefined),
      duet: { url: 'http://helper', token: 'secret' },
    });
    await vi.waitFor(() => {
      expect(engine.status().status).toBe('ready');
    });

    engine.startDuet();
    await vi.waitFor(() => {
      expect(engine.status().duet?.state).toBe('ready');
    });

    const status = engine.status().duet;
    expect(status?.source).toBe('helper');
    expect(status?.lowConfidenceSeconds).toBe(20);
    expect(duetHelper.constructed).toBe(1);
    const writes = vi.mocked(store.writeCachedDuet).mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe(entry.key);
    const savedVoices = writes[0]?.[1].voices as readonly [Float32Array, Float32Array];
    expect(savedVoices[0].length).toBe(400);
    expect(savedVoices[1].length).toBe(400);
    expect(writes[0]?.[1].map).toMatchObject({
      anchors: [{ voice: 1, start: 1, end: 2 }],
      quality: { lowConfidence: 20 },
    });

    await engine.stop();
  });

  it('rewrites the sidecar after an anchor re-render', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      modelVersion: 'htdemucs-web',
      durationFrames: 400,
      bytes: 9000,
    });
    const writer = new FakeWriter(entry);
    const store = missStore(writer);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { 'content-length': '16' },
        }),
      ),
    );
    const engine = await startEngine({
      ...engineOptions(store, () => undefined),
      duet: { url: 'http://helper', token: 'secret' },
    });
    await vi.waitFor(() => {
      expect(engine.status().status).toBe('ready');
    });
    engine.startDuet();
    await vi.waitFor(() => {
      expect(vi.mocked(store.writeCachedDuet).mock.calls).toHaveLength(1);
    });

    engine.anchorDuet(1, 5);
    await vi.waitFor(() => {
      expect(vi.mocked(store.writeCachedDuet).mock.calls).toHaveLength(2);
    });

    const second = vi.mocked(store.writeCachedDuet).mock.calls[1]?.[1];
    expect(duetHelper.anchorCalls).toBe(1);
    expect(second?.map).toMatchObject({
      anchors: [
        { voice: 1, start: 1, end: 2 },
        { voice: 1, start: 2, end: 3 },
      ],
      quality: { lowConfidence: 0 },
    });
    expect(engine.status().duet?.state).toBe('ready');
    expect(engine.status().duet?.lowConfidenceSeconds).toBe(0);

    await engine.stop();
  });

  it('keeps the helper result when the sidecar cannot be written', async () => {
    const entry = seedEntry(VIDEO, {
      formatVersion: CACHE_FORMAT_VERSION,
      modelVersion: 'htdemucs-web',
      durationFrames: 400,
      bytes: 9000,
    });
    const writer = new FakeWriter(entry);
    const store = missStore(writer, { duetWriteFails: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { 'content-length': '16' },
        }),
      ),
    );
    const engine = await startEngine({
      ...engineOptions(store, () => undefined),
      duet: { url: 'http://helper', token: 'secret' },
    });
    await vi.waitFor(() => {
      expect(engine.status().status).toBe('ready');
    });

    engine.startDuet();
    await vi.waitFor(() => {
      expect(engine.status().duet?.state).toBe('ready');
    });

    expect(engine.status().duet?.source).toBe('helper');
    expect(engine.status().duet?.hasVoices).toBe(true);
    expect(engine.status().status).toBe('ready');
    expect(vi.mocked(store.writeCachedDuet)).toHaveBeenCalledTimes(1);

    await engine.stop();
  });
});
