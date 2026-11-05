import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StemPlayerCommand } from '../src/audio/stem-player-messages.ts';

/**
 * The worklet, run as an ordinary module.
 *
 * An `AudioWorkletProcessor` is a class the browser instantiates for us, but
 * nothing in the class needs the browser: it reads `currentTime` and
 * `sampleRate`, receives commands on a port, and fills output arrays. So the
 * three globals are stubbed and the class is captured from `registerProcessor`.
 * That makes the two things that went wrong on a seek and a pause — the master
 * fading to nought and never coming back — ordinary assertions.
 */

const RATE = 44100;
const QUANTUM = 128;
const LATENCY_SECONDS = 2048 / RATE;

interface Port {
  onmessage: ((event: MessageEvent<StemPlayerCommand>) => void) | null;
  postMessage: (message: unknown) => void;
}

interface Processor {
  readonly port: Port;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}

class FakeProcessor {
  readonly port: Port = { onmessage: null, postMessage: () => undefined };
}

let ProcessorClass: (new () => Processor) | null = null;
let now = 0;

function command(processor: Processor, message: StemPlayerCommand): void {
  processor.port.onmessage?.({ data: message } as MessageEvent<StemPlayerCommand>);
}

/** What each stem is worth in the mixer tests, in `STEMS` order. */
const STEM_VALUES = [0.05, 0.1, 0.15, 0.2] as const;

/**
 * A constant value in every channel, with one value per stem.
 *
 * Constants rather than a tone because the assertions are about levels: what
 * leaves the mixer is exactly the weighted sum of these, with no phase to
 * allow for. A stem's left and right carry the same number, so either output
 * channel says the same thing.
 */
function stems(seconds: number, values: readonly number[] = STEM_VALUES): Float32Array[] {
  const channels: Float32Array[] = [];
  for (const value of values) {
    for (let side = 0; side < 2; side += 1) {
      channels.push(new Float32Array(Math.floor(seconds * RATE)).fill(value));
    }
  }
  return channels;
}

function start(): Processor {
  if (ProcessorClass === null) {
    throw new Error('the worklet did not register');
  }
  now = 0;
  vi.stubGlobal('currentTime', 0);
  const processor = new ProcessorClass();
  command(processor, { type: 'stems', channels: stems(4) });
  command(processor, { type: 'mix', gains: [1, 1, 1, 1], seconds: 0.03 });
  command(processor, { type: 'master', target: 1, seconds: 0.03, shape: 'linear' });
  command(processor, { type: 'playing', playing: true });
  return processor;
}

/**
 * Runs `seconds` of audio and returns the loudest sample of each quantum.
 *
 * The shifter holds everything for one 2048-sample frame, so anything asserted
 * about the output has to allow for that before it looks.
 */
function run(processor: Processor, seconds: number): number[] {
  const peaks: number[] = [];
  const frames = Math.ceil((seconds * RATE) / QUANTUM);
  for (let quantum = 0; quantum < frames; quantum += 1) {
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    (globalThis as unknown as { currentTime: number }).currentTime = now;
    processor.process([], [[left, right]]);
    let peak = 0;
    for (let index = 0; index < QUANTUM; index += 1) {
      peak = Math.max(peak, Math.abs(left[index] ?? 0), Math.abs(right[index] ?? 0));
    }
    peaks.push(peak);
    now += QUANTUM / RATE;
  }
  return peaks;
}

function loudest(peaks: readonly number[], from: number, to: number): number {
  let peak = 0;
  for (let index = Math.max(0, from); index < Math.min(peaks.length, to); index += 1) {
    peak = Math.max(peak, peaks[index] ?? 0);
  }
  return peak;
}

/** Quantums in a number of seconds, for indexing `run`'s output. */
function quanta(seconds: number): number {
  return Math.ceil((seconds * RATE) / QUANTUM);
}

beforeAll(async () => {
  vi.stubGlobal('AudioWorkletProcessor', FakeProcessor);
  vi.stubGlobal('sampleRate', RATE);
  vi.stubGlobal('currentTime', 0);
  vi.stubGlobal(
    'registerProcessor',
    (_name: string, processor: new () => Processor): void => {
      ProcessorClass = processor;
    },
  );
  await import('../src/worklets/stem-player.worklet.ts');
});

beforeEach(() => {
  vi.stubGlobal('currentTime', 0);
});

describe('the stem player', () => {
  it('starts making sound once the shifter has filled', () => {
    const processor = start();
    const peaks = run(processor, 0.4);
    expect(loudest(peaks, quanta(LATENCY_SECONDS + 0.05), peaks.length)).toBeGreaterThan(0.1);
  });

  it('comes back after a seek, rather than staying silent', () => {
    const processor = start();
    run(processor, 0.3);
    command(processor, { type: 'anchor', mediaSeconds: 1, rate: 1 });
    const peaks = run(processor, 0.4);
    // The jump fades out and then has to fade back in; the last tenth of a
    // second is after both, and before this fix it was the silence the rest
    // of the song was played into.
    expect(loudest(peaks, peaks.length - quanta(0.1), peaks.length)).toBeGreaterThan(0.1);
  });

  it('plays up to the frontier, then picks up when the next block arrives', () => {
    const processor = start();
    // Start again with an empty whole track, as the engine does before the
    // first separated block exists.
    command(processor, { type: 'begin', frames: 2 * RATE });
    command(processor, { type: 'mix', gains: [1, 1, 1, 1], seconds: 0.03 });
    command(processor, { type: 'master', target: 1, seconds: 0.03, shape: 'linear' });
    command(processor, { type: 'playing', playing: true });
    const first = stems(0.5);
    command(processor, { type: 'stem-block', startSample: 0, channels: first });

    const opening = run(processor, 1.2);
    expect(loudest(opening, quanta(LATENCY_SECONDS + 0.05), quanta(0.5))).toBeGreaterThan(0.1);
    // The head stops at the frontier rather than reading the zeros behind it.
    expect(loudest(opening, quanta(0.8), opening.length)).toBeLessThan(0.001);

    const second = stems(0.5);
    command(processor, {
      type: 'stem-block',
      startSample: first[0]?.length ?? 0,
      channels: second,
    });
    const resumed = run(processor, 0.4);
    expect(loudest(resumed, quanta(0.1), resumed.length)).toBeGreaterThan(0.1);
  });

  it('fades a pause to silence after the shifter has drained', () => {
    const processor = start();
    run(processor, 0.3);
    command(processor, { type: 'playing', playing: false });
    const peaks = run(processor, 0.2);
    expect(loudest(peaks, peaks.length - quanta(0.05), peaks.length)).toBeLessThan(0.001);
  });

  it('comes back after a pause, at the place the anchor says', () => {
    const processor = start();
    run(processor, 0.3);
    command(processor, { type: 'playing', playing: false });
    run(processor, 0.2);
    command(processor, { type: 'playing', playing: true });
    command(processor, { type: 'anchor', mediaSeconds: 1.2, rate: 1 });
    const peaks = run(processor, 0.4);
    expect(loudest(peaks, peaks.length - quanta(0.1), peaks.length)).toBeGreaterThan(0.1);
  });

  it('stays silent after a resume when the mode is the video’s own sound', () => {
    const processor = start();
    run(processor, 0.3);
    command(processor, { type: 'playing', playing: false });
    command(processor, { type: 'master', target: 0, seconds: 0.03, shape: 'linear' });
    run(processor, 0.2);
    command(processor, { type: 'playing', playing: true });
    command(processor, { type: 'anchor', mediaSeconds: 1.2, rate: 1 });
    const peaks = run(processor, 0.4);
    expect(loudest(peaks, peaks.length - quanta(0.1), peaks.length)).toBeLessThan(0.001);
  });
});

describe('the mixer', () => {
  /** The gains that leave one stem at full and the rest silent. */
  function only(stem: number): number[] {
    return STEM_VALUES.map((_value, index) => (index === stem ? 1 : 0));
  }

  function settled(processor: Processor): number {
    const peaks = run(processor, 0.3);
    return loudest(peaks, quanta(LATENCY_SECONDS + 0.05), peaks.length);
  }

  it('plays each stem at its own level', () => {
    for (let stem = 0; stem < STEM_VALUES.length; stem += 1) {
      const processor = start();
      command(processor, { type: 'mix', gains: only(stem), seconds: 0 });
      expect(settled(processor)).toBeCloseTo(STEM_VALUES[stem] ?? 0, 4);
    }
  });

  it('adds the stems together rather than choosing between them', () => {
    const processor = start();
    command(processor, { type: 'mix', gains: [1, 1, 0, 0], seconds: 0 });
    expect(settled(processor)).toBeCloseTo(0.05 + 0.1, 4);
  });

  it('clamps a gain that arrived out of range, one stem at a time', () => {
    const processor = start();
    command(processor, { type: 'mix', gains: [4, -1, Number.NaN, 0.5], seconds: 0 });
    // The first at full, the middle two silent, the last at half.
    expect(settled(processor)).toBeCloseTo(0.05 + 0.1, 4);
  });

  it('changes one stem without disturbing the others', () => {
    const processor = start();
    command(processor, { type: 'mix', gains: [1, 1, 1, 1], seconds: 0 });
    expect(settled(processor)).toBeCloseTo(0.5, 4);
    command(processor, { type: 'mix', gains: [1, 1, 1, 0], seconds: 0 });
    expect(settled(processor)).toBeCloseTo(0.3, 4);
  });
});
