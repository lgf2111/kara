import { describe, expect, it } from 'vitest';

import { SEGMENT_SAMPLES, SOURCES } from '../src/separation/htdemucs.ts';
import { planJob } from '../src/separation/job.ts';
import { createStreamingSeparator, type StreamBlock } from '../src/separation/streaming.ts';
import type { SegmentRunner } from '../src/separation/segment-contract.ts';

/**
 * Windows small enough to follow by hand, with the model's own 25% overlap.
 * The runner's segment is deliberately longer than the window, which is the
 * zero-padded shape streaming.ts runs when latency matters more than the last
 * of the separation quality.
 */
const WINDOW = 20;
const HOP = 15;
const SEGMENT = 32;
const RATE = 44100;
/** How loud the fake runner's instrumental is against its input. */
const MIX = 0.5;

/**
 * How each source is scaled against the input, in `SOURCES` order. The three
 * backing sources add up to {@link MIX}, so the pair the old player reads and
 * the four the mixer reads describe the same separation.
 */
const STEM_SCALE = [0.1, 0.2, 0.2, 1] as const;

/**
 * Stands in for the model: hands the vocal straight back and returns an
 * instrumental at half the amplitude. Whatever comes out of the stitching then
 * says exactly which input samples it was made of.
 */
function fakeRunner(segmentSamples: number): SegmentRunner & { readonly windows: number } {
  const stems = SOURCES.map(() => new Float32Array(segmentSamples * 2));
  const vocals = new Float32Array(segmentSamples * 2);
  const instrumental = new Float32Array(segmentSamples * 2);
  let windows = 0;

  return {
    segmentSamples,
    islands: 0,
    get windows() {
      return windows;
    },
    run(left, right) {
      windows += 1;
      for (let frame = 0; frame < segmentSamples; frame += 1) {
        const l = left[frame] ?? 0;
        const r = right[frame] ?? 0;
        vocals[frame * 2] = l;
        vocals[frame * 2 + 1] = r;
        instrumental[frame * 2] = l * MIX;
        instrumental[frame * 2 + 1] = r * MIX;
        for (let index = 0; index < stems.length; index += 1) {
          const stem = stems[index];
          const scale = STEM_SCALE[index];
          if (stem === undefined || scale === undefined) {
            continue;
          }
          stem[frame * 2] = l * scale;
          stem[frame * 2 + 1] = r * scale;
        }
      }
      return Promise.resolve({
        stems,
        vocals,
        instrumental,
        inferenceMs: 1,
        nonFinite: 0,
        stemSumError: 0,
      });
    },
    release() {
      return Promise.resolve();
    },
  };
}

/** The same runner, with every window held until the test lets it go. */
function gatedRunner(base: SegmentRunner): SegmentRunner & { openAll: () => void } {
  const waiting: (() => void)[] = [];
  let open = false;
  return {
    segmentSamples: base.segmentSamples,
    islands: base.islands,
    async run(left, right) {
      if (!open) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return base.run(left, right);
    },
    release() {
      return base.release();
    },
    openAll() {
      open = true;
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    },
  };
}

/** Lets everything already queued run, so a window reaches the fake model. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function sine(length: number, step: number, phase = 0): Float32Array {
  return Float32Array.from({ length }, (_, index) => Math.sin(index * step + phase));
}

interface Sink {
  readonly onBlock: (block: StreamBlock) => void;
  readonly spans: { start: number; frames: number }[];
  readonly vocals: [Float32Array, Float32Array];
  readonly instrumental: [Float32Array, Float32Array];
}

/** Lays every block back down on one timeline, so gaps show up as silence. */
function sink(length: number, offset = 0): Sink {
  const vocals: [Float32Array, Float32Array] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  const instrumental: [Float32Array, Float32Array] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  const spans: { start: number; frames: number }[] = [];
  return {
    spans,
    vocals,
    instrumental,
    onBlock(block) {
      const at = block.startSample - offset;
      spans.push({ start: block.startSample, frames: block.vocals[0].length });
      vocals[0].set(block.vocals[0], at);
      vocals[1].set(block.vocals[1], at);
      instrumental[0].set(block.instrumental[0], at);
      instrumental[1].set(block.instrumental[1], at);
    },
  };
}

/** Lays every separate source back down, for a test of the mixer's blocks. */
function stemSink(length: number): {
  readonly onBlock: (block: StreamBlock) => void;
  readonly stems: [Float32Array, Float32Array][];
} {
  const stems: [Float32Array, Float32Array][] = SOURCES.map(() => [
    new Float32Array(length),
    new Float32Array(length),
  ]);
  return {
    stems,
    onBlock(block) {
      const pairs = block.stems ?? [];
      for (let index = 0; index < pairs.length; index += 1) {
        const pair = pairs[index];
        const into = stems[index];
        if (pair === undefined || into === undefined) {
          continue;
        }
        into[0].set(pair[0], block.startSample);
        into[1].set(pair[1], block.startSample);
      }
    },
  };
}

function maxError(actual: Float32Array, wanted: Float32Array): number {  let worst = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    worst = Math.max(worst, Math.abs((actual[index] ?? 0) - (wanted[index] ?? 0)));
  }
  return worst;
}

function scaled(signal: Float32Array, by: number): Float32Array {
  return Float32Array.from(signal, (value) => value * by);
}

/** Pushes a whole signal in chunk sizes nothing like the window. */
async function pushAll(
  separator: { push: (left: Float32Array, right: Float32Array) => Promise<void> },
  left: Float32Array,
  right: Float32Array,
  sizes: readonly number[],
): Promise<void> {
  let at = 0;
  let next = 0;
  while (at < left.length) {
    const size = Math.min(sizes[next % sizes.length] ?? 1, left.length - at);
    await separator.push(left.subarray(at, at + size), right.subarray(at, at + size));
    at += size;
    next += 1;
  }
}

describe('createStreamingSeparator', () => {
  it('emits blocks that tile the timeline exactly, whatever the chunks were', async () => {
    const total = 103;
    const left = sine(total, 0.05);
    const right = sine(total, 0.05, Math.PI / 3);
    const runner = fakeRunner(SEGMENT);
    const collected = sink(total);
    const separator = createStreamingSeparator({
      runner,
      onBlock: collected.onBlock,
      windowSamples: WINDOW,
      hopSamples: HOP,
      sampleRate: RATE,
    });

    await pushAll(separator, left, right, [7, 1, 13, 2, 41, 3]);
    await separator.flush();

    // One hop per block until the flush, which clears what is left of the
    // last window: in order, no gap, nothing counted twice, nothing over.
    expect(collected.spans).toEqual([
      { start: 0, frames: 15 },
      { start: 15, frames: 15 },
      { start: 30, frames: 15 },
      { start: 45, frames: 15 },
      { start: 60, frames: 15 },
      { start: 75, frames: 15 },
      { start: 90, frames: 13 },
    ]);

    // And the audio is the fake runner's stems, put back together.
    expect(maxError(collected.vocals[0], left)).toBeLessThan(1e-6);
    expect(maxError(collected.vocals[1], right)).toBeLessThan(1e-6);
    expect(maxError(collected.instrumental[0], scaled(left, MIX))).toBeLessThan(1e-6);
    expect(maxError(collected.instrumental[1], scaled(right, MIX))).toBeLessThan(1e-6);
  });

  it('stitches every source separately when a mixer asks for them', async () => {
    const total = 103;
    const left = sine(total, 0.05);
    const right = sine(total, 0.05, Math.PI / 3);
    const collected = stemSink(total);
    const separator = createStreamingSeparator({
      runner: fakeRunner(SEGMENT),
      onBlock: collected.onBlock,
      windowSamples: WINDOW,
      hopSamples: HOP,
      stems: 'all',
    });

    await pushAll(separator, left, right, [7, 1, 13, 2, 41, 3]);
    await separator.flush();

    for (let index = 0; index < SOURCES.length; index += 1) {
      const pair = collected.stems[index];
      const scale = STEM_SCALE[index] ?? 0;
      expect(pair, SOURCES[index]).toBeDefined();
      if (pair === undefined) {
        continue;
      }
      expect(maxError(pair[0], scaled(left, scale))).toBeLessThan(1e-6);
      expect(maxError(pair[1], scaled(right, scale))).toBeLessThan(1e-6);
    }

    // The three backing sources are the pair's instrumental, which is what
    // makes the four gains and the old karaoke path one separation.
    const [drums, bass, other] = collected.stems;
    if (drums === undefined || bass === undefined || other === undefined) {
      throw new Error('the separator did not return all the backing stems');
    }
    for (let frame = 0; frame < total; frame += 1) {
      expect(
        (drums[0][frame] ?? 0) + (bass[0][frame] ?? 0) + (other[0][frame] ?? 0),
      ).toBeCloseTo(scaled(left, MIX)[frame] ?? 0, 6);
    }
  });

  it('leaves the separate sources out when only the pair was asked for', async () => {
    const total = 40;
    const signal = sine(total, 0.05);
    const blocks: StreamBlock[] = [];
    const separator = createStreamingSeparator({
      runner: fakeRunner(SEGMENT),
      onBlock: (block) => blocks.push(block),
      windowSamples: WINDOW,
      hopSamples: HOP,
    });

    await pushAll(separator, signal, signal, [9]);
    await separator.flush();

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.stems).toBeUndefined();
    }
  });

  it('runs the same windows the file pipeline would for the same audio', async () => {
    for (const total of [12, 20, 21, 35, 103, 150]) {
      const runner = fakeRunner(SEGMENT);
      const collected = sink(total);
      const separator = createStreamingSeparator({
        runner,
        onBlock: collected.onBlock,
        windowSamples: WINDOW,
        hopSamples: HOP,
      });

      const signal = sine(total, 0.05);
      await pushAll(separator, signal, signal, [5, 17, 1]);
      await separator.flush();

      expect(runner.windows).toBe(planJob(total, WINDOW, 1 - HOP / WINDOW).total);
      const last = collected.spans.at(-1);
      expect(last?.start ?? 0).toBe(
        collected.spans.slice(0, -1).reduce((sum, span) => sum + span.frames, 0),
      );
      expect((last?.start ?? 0) + (last?.frames ?? 0)).toBe(total);
    }
  });

  it('emits one block for a stream shorter than a single window', async () => {
    const total = 12;
    const signal = sine(total, 0.1);
    const collected = sink(total);
    const separator = createStreamingSeparator({
      runner: fakeRunner(SEGMENT),
      onBlock: collected.onBlock,
      windowSamples: WINDOW,
      hopSamples: HOP,
    });

    await pushAll(separator, signal, signal, [5]);
    await separator.flush();

    expect(collected.spans).toEqual([{ start: 0, frames: total }]);
    expect(maxError(collected.vocals[0], signal)).toBeLessThan(1e-6);
  });

  it('emits nothing for a stream that carried no audio', async () => {
    const blocks: StreamBlock[] = [];
    const separator = createStreamingSeparator({
      runner: fakeRunner(SEGMENT),
      onBlock: (block) => blocks.push(block),
      windowSamples: WINDOW,
      hopSamples: HOP,
    });

    await separator.flush();
    expect(blocks).toEqual([]);
  });

  it('restarts the timeline at a seek', async () => {
    const runner = fakeRunner(SEGMENT);
    const before = sink(40);
    let target: Sink = before;
    const separator = createStreamingSeparator({
      runner,
      onBlock: (block) => {
        target.onBlock(block);
      },
      windowSamples: WINDOW,
      hopSamples: HOP,
    });

    const first = sine(40, 0.05);
    await pushAll(separator, first, first, [9]);
    expect(before.spans).toEqual([{ start: 0, frames: HOP }]);

    const total = 50;
    const seeked = sink(total, 1000);
    target = seeked;
    separator.reset(1000);

    const second = sine(total, 0.02);
    await pushAll(separator, second, second, [11]);
    await separator.flush();

    let end = 1000;
    for (const span of seeked.spans) {
      expect(span.start).toBe(end);
      end += span.frames;
    }
    expect(end).toBe(1000 + total);
    expect(maxError(seeked.vocals[0], second)).toBeLessThan(1e-6);
  });

  it('throws away a window the model was holding when a seek landed', async () => {
    const runner = gatedRunner(fakeRunner(SEGMENT));
    const blocks: StreamBlock[] = [];
    const separator = createStreamingSeparator({
      runner,
      onBlock: (block) => blocks.push(block),
      windowSamples: WINDOW,
      hopSamples: HOP,
    });

    const signal = sine(WINDOW * 2, 0.05);
    const pushed = separator.push(signal, signal);
    await settle();
    separator.reset(1000);
    runner.openAll();
    await pushed;

    // Both windows belonged to the timeline the seek threw away.
    expect(blocks).toEqual([]);

    const second = sine(40, 0.02);
    await pushAll(separator, second, second, [13]);
    await separator.flush();
    expect(blocks[0]?.startSample).toBe(1000);
  });

  it('refuses a push once the stream has been flushed', async () => {
    const signal = sine(WINDOW, 0.05);
    const separator = createStreamingSeparator({
      runner: fakeRunner(SEGMENT),
      onBlock: () => undefined,
      windowSamples: WINDOW,
      hopSamples: HOP,
    });

    await separator.push(signal, signal);
    await separator.flush();
    expect(() => separator.push(signal, signal)).toThrow(/reset/u);

    separator.reset();
    await separator.push(signal, signal);
  });

  it('refuses a window the runner has no room for', () => {
    expect(() =>
      createStreamingSeparator({
        runner: fakeRunner(WINDOW - 1),
        onBlock: () => undefined,
        windowSamples: WINDOW,
        hopSamples: HOP,
      }),
    ).toThrow(/does not fit/u);
  });

  it('reports the lag a player has to sit behind live at', async () => {
    const total = 103;
    const signal = sine(total, 0.05);
    const collected = sink(total);
    const separator = createStreamingSeparator({
      runner: fakeRunner(SEGMENT),
      onBlock: collected.onBlock,
      windowSamples: WINDOW,
      hopSamples: HOP,
      sampleRate: RATE,
    });

    const structural = ((WINDOW + HOP) / RATE) * 1000;
    expect(separator.latency().bufferSamples).toBe(0);

    await pushAll(separator, signal, signal, [7, 1, 13]);
    const running = separator.latency();
    // Whatever has arrived that no block covers yet, which is one window's
    // worth of audio give or take a hop.
    expect(running.bufferSamples).toBe(total - collected.spans.length * HOP);
    expect(running.bufferSamples).toBeGreaterThan(0);
    expect(running.totalLagMs).toBeGreaterThanOrEqual(structural);
    expect(running.totalLagMs - running.computeMs).toBeCloseTo(structural, 6);

    await separator.flush();
    expect(separator.latency().bufferSamples).toBe(0);
  });

  it('defaults to the window and overlap the file pipeline separates with', () => {
    const separator = createStreamingSeparator({
      runner: fakeRunner(SEGMENT_SAMPLES),
      onBlock: () => undefined,
    });

    expect(separator.plan.segment).toBe(SEGMENT_SAMPLES);
    expect(separator.plan.stride).toBe(planJob(SEGMENT_SAMPLES * 4, SEGMENT_SAMPLES, 0.25).stride);
    // 7.8 s of window and 5.85 s of hop: 13.65 s behind live before the model
    // has computed anything. A shorter window is the only way down.
    expect(separator.latency().totalLagMs).toBeCloseTo(13650, 2);
  });
});
