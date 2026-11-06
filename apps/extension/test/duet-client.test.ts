import { describe, expect, it } from 'vitest';

import {
  DuetClient,
  errorText,
  remoteDuetMap,
  remoteDuetStatus,
  type DecodeStereo,
  type FetchLike,
} from '../src/audio/duet-client.ts';
import { DEFAULT_DUET_CONFIG } from '../src/audio/duet.ts';

const CONFIG = { ...DEFAULT_DUET_CONFIG, url: 'http://helper', token: 'secret' };
const DECODE: DecodeStereo = () =>
  Promise.resolve([new Float32Array(), new Float32Array()]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(responses: Response[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error('no fake response left');
    }
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

function headers(call: Call): Record<string, string> {
  return call.init?.headers as Record<string, string>;
}

describe('remoteDuetStatus', () => {
  it('normalises the bridge shape', () => {
    expect(
      remoteDuetStatus({
        state: 'running',
        phase: 'mapping',
        done: 2.9,
        total: 5.2,
        error: null,
        version: 3,
      }),
    ).toEqual({
      state: 'running',
      phase: 'mapping',
      done: 2,
      total: 5,
      error: null,
      version: 3,
    });
  });

  it('falls back on unknown values rather than trusting them', () => {
    expect(remoteDuetStatus({ state: 'weird', phase: 'nope', done: -4, total: 'x' })).toEqual({
      state: 'running',
      phase: 'starting',
      done: 0,
      total: 0,
      error: null,
      version: 0,
    });
    expect(remoteDuetStatus(null).state).toBe('running');
    expect(remoteDuetStatus({ state: 'error', error: 'cancelled' }).error).toBe('cancelled');
  });
});

describe('DuetClient', () => {
  it('starts a job with the token and the WAV body', async () => {
    const { fetch, calls } = fakeFetch([json({ jobId: 'job-1' })]);
    const client = new DuetClient(CONFIG, DECODE, fetch);

    const jobId = await client.start(new Blob(['wav']));

    expect(jobId).toBe('job-1');
    expect(calls[0]?.url).toBe('http://helper/v1/jobs');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeInstanceOf(Blob);
    expect(headers(calls[0] as Call)).toMatchObject({
      'X-Kara-Token': 'secret',
      'Content-Type': 'audio/wav',
    });
  });

  it('surfaces the helper error body', async () => {
    const { fetch } = fakeFetch([json({ error: 'bad token' }, 401)]);
    const client = new DuetClient(CONFIG, DECODE, fetch);

    await expect(client.start(new Blob(['wav']))).rejects.toThrow('bad token');
  });

  it('polls and parses a status', async () => {
    const { fetch, calls } = fakeFetch([
      json({ state: 'running', phase: 'separating', done: 4, total: 10, version: 1 }),
    ]);
    const client = new DuetClient(CONFIG, DECODE, fetch);

    const status = await client.status('job-1');

    expect(status).toMatchObject({ state: 'running', phase: 'separating', done: 4, total: 10 });
    expect(calls[0]?.url).toBe('http://helper/v1/jobs/job-1');
    expect(headers(calls[0] as Call)).toEqual({ 'X-Kara-Token': 'secret' });
  });

  it('posts a calibration anchor as JSON', async () => {
    const { fetch, calls } = fakeFetch([json({ state: 'running' })]);
    const client = new DuetClient(CONFIG, DECODE, fetch);

    await client.anchor('job-1', 2, 3.5, 6.5);

    expect(calls[0]?.url).toBe('http://helper/v1/jobs/job-1/anchors');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ voice: 2, start: 3.5, end: 6.5 }));
    expect(headers(calls[0] as Call)['Content-Type']).toBe('application/json');
  });

  it('cancels with a POST', async () => {
    const { fetch, calls } = fakeFetch([json({ state: 'error', error: 'cancelled' })]);
    const client = new DuetClient(CONFIG, DECODE, fetch);

    await client.cancel('job-1');

    expect(calls[0]?.url).toBe('http://helper/v1/jobs/job-1/cancel');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('decodes both voices and trims to the track length', async () => {
    const { fetch, calls } = fakeFetch([
      new Response(new Uint8Array([7])),
      new Response(new Uint8Array([8])),
    ]);
    const decode = (bytes: ArrayBuffer): Promise<[Float32Array, Float32Array]> => {
      const value = new Uint8Array(bytes)[0] ?? 0;
      return Promise.resolve([
        Float32Array.from([value, 1, 2]),
        Float32Array.from([value + 1, 3, 4]),
      ]);
    };
    const client = new DuetClient(CONFIG, decode, fetch);

    const [first, second] = await client.voices('job-1', 2);

    expect(Array.from(first)).toEqual([7, 1]);
    expect(Array.from(second)).toEqual([8, 1]);
    expect(calls.map((call) => call.url)).toEqual([
      'http://helper/v1/jobs/job-1/voice1.wav',
      'http://helper/v1/jobs/job-1/voice2.wav',
    ]);
  });

  it('reads the map confidence and tolerates a missing map', async () => {
    const { fetch } = fakeFetch([json({ quality: { lowConfidence: 12.5 } })]);
    const client = new DuetClient(CONFIG, DECODE, fetch);
    expect(await client.lowConfidence('job-1')).toBe(12.5);

    const missing = fakeFetch([json({}, 404)]);
    const noMap = new DuetClient(CONFIG, DECODE, missing.fetch);
    expect(await noMap.lowConfidence('job-1')).toBeNull();
  });

  it('reads the whole map once for the cache to persist', async () => {
    const body = {
      version: 1,
      anchors: [{ voice: 1, start: 1.5, end: 4.5 }],
      quality: { solo: 8, lowConfidence: 2.5 },
      segments: [{ start: 0, end: 2, kind: 'solo', voice: 1 }],
    };
    const { fetch, calls } = fakeFetch([json(body)]);
    const client = new DuetClient(CONFIG, DECODE, fetch);

    const map = await client.map('job-1');

    expect(calls[0]?.url).toBe('http://helper/v1/jobs/job-1/map.json');
    expect(headers(calls[0] as Call)).toEqual({ 'X-Kara-Token': 'secret' });
    expect(map).toEqual({
      map: body,
      anchors: body.anchors,
      quality: body.quality,
      lowConfidenceSeconds: 2.5,
    });
  });

  it('normalises a map without anchors or quality', () => {
    expect(remoteDuetMap(null)).toEqual({
      map: {},
      anchors: [],
      quality: {},
      lowConfidenceSeconds: null,
    });
    expect(
      remoteDuetMap({
        anchors: [{ voice: 3, start: 0, end: 1 }, { voice: 2, start: 2, end: 3 }],
        quality: { lowConfidence: 'x', solo: 1 },
      }),
    ).toEqual({
      map: {
        anchors: [{ voice: 3, start: 0, end: 1 }, { voice: 2, start: 2, end: 3 }],
        quality: { lowConfidence: 'x', solo: 1 },
      },
      anchors: [{ voice: 2, start: 2, end: 3 }],
      quality: { solo: 1 },
      lowConfidenceSeconds: null,
    });
  });

  it('calls the browser fetch without the client as its receiver', async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(
        json({ state: 'running', phase: 'starting', done: 0, total: 0, version: 1 }),
      );
    } as typeof fetch;
    try {
      const client = new DuetClient(CONFIG, DECODE);
      await client.status('job-1');
    } finally {
      globalThis.fetch = original;
    }
    expect(receivers[0]).toBeUndefined();
  });

  it('reads a non-JSON error as its status', async () => {
    expect(await errorText(new Response('nope', { status: 502 }))).toBe(
      'the helper returned 502',
    );
  });
});
