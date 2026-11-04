import { SAMPLE_RATE, SEGMENT_SAMPLES } from './htdemucs.ts';
import { medianMs, type JobPlan } from './job.ts';
import { createStitcher } from './stitch.ts';
import {
  createBlockTiling,
  createWindowBuffer,
  deinterleave,
  latencyReport,
  streamPlan,
  type LatencyReport,
} from './stream-buffer.ts';
import type { SegmentRunner } from './segment-contract.ts';

/**
 * Separation of audio that is still arriving.
 *
 * separate.worker.ts has a whole file in hand and can take its time. A tab
 * capture cannot: samples turn up in whatever sized chunks the capture feels
 * like, and the instrumental has to come back soon enough that a person can
 * sing to it. So the same windows, the same crossfade and the same stitching
 * maths run here, driven by arrival rather than by a loop over a plan, and
 * what comes out are finalised blocks that tile the timeline exactly once.
 *
 * The runner is passed in rather than built here, which keeps this file free
 * of onnxruntime-web and lets the tiling be tested against a fake runner.
 *
 * ## Why it is late, and what that costs
 *
 * A window is only final once the next one has been run, so the finalised
 * frontier trails live audio by one window, and it moves in hops. The delay a
 * player can hold without running dry is a window plus a hop plus the time a
 * window costs to compute; {@link StreamingSeparator.latency} is that number.
 *
 * The model's own window is 7.8 s and its 25% overlap puts the hop at 5.85 s,
 * so the defaults are 13.65 s behind live before a single multiply, and about
 * 16 s once a GPU that separates at 3.4x realtime has spent 2.3 s on each
 * window. Getting near 8 s means a shorter window.
 *
 * ## Shorter windows
 *
 * The graph's segment is fixed at export time, so a shorter window cannot mean
 * a shorter tensor: it means real audio at the front of the segment and zeros
 * behind it, which is exactly what demucs does to the last chunk of a file.
 * That needs no retraining and it is what `windowSamples` does here. Three
 * things to know before turning it down:
 *
 * - compute per window does not change. The graph runs over its full 7.8 s
 *   whatever fraction of that is real audio, so a shorter window raises the
 *   cost per second of audio.
 * - the hop has to stay longer than that compute time or the stream falls
 *   behind for good, and no fixed delay rescues it. On WebGPU at 3.4x realtime
 *   that floor is about 2.3 s, which is why a 3 s window with a 2.6 s hop is
 *   roughly the shape that lands near 8 s: 3 + 2.6 + 2.3. It leaves little
 *   headroom. On WASM at 1.2x realtime the floor is about 6.5 s and there is
 *   no useful shape at all, so live separation is a WebGPU feature.
 * - the model sees the audio stop dead at the window's edge and smears
 *   transients near it. The crossfade covers the worst of it, since the
 *   degraded tail of one window fades into the middle of the next, but a 3 s
 *   window is not the separation the file path gives.
 *
 * Measure it with the report rather than trusting any of those numbers.
 */

/** The overlap library/ingest.ts separates files with, and demucs' default. */
const NATIVE_OVERLAP = 0.25;

/**
 * Windows the latency report averages over. Recent ones only: a machine that
 * has started to thermally throttle is the machine the picture delay has to
 * suit, not the one that started the song.
 */
const COMPUTE_HISTORY = 32;

/** A stretch of separated audio that can no longer change. */
export interface StreamBlock {
  /** Absolute sample index of the first frame, counted from the last reset. */
  readonly startSample: number;
  /** Left and right, as long as the block. */
  readonly vocals: readonly [Float32Array, Float32Array];
  readonly instrumental: readonly [Float32Array, Float32Array];
}

export interface StreamingOptions {
  readonly runner: SegmentRunner;
  /**
   * Called once per finalised block, in order. The buffers belong to the
   * separator and the next block overwrites them: copy what is kept.
   */
  readonly onBlock: (block: StreamBlock) => void;
  /** Defaults to the model's 44.1 kHz, which is what it was trained on. */
  readonly sampleRate?: number;
  /** Live samples per window. Defaults to the whole of the model's segment. */
  readonly windowSamples?: number;
  /** Samples between windows. Defaults to the model's native 25% overlap. */
  readonly hopSamples?: number;
}

export interface StreamingSeparator {
  /** The window, hop and crossfade this is running with. */
  readonly plan: JobPlan;
  /**
   * Takes however many samples just arrived and separates whatever that
   * completes. Resolves once there is nothing left to run, so awaiting it
   * applies backpressure; a caller that does not await must still handle the
   * rejection.
   */
  push(left: Float32Array, right: Float32Array): Promise<void>;
  /**
   * Ends the stream: runs what is left over a zero-padded window and emits the
   * last block. Pushing after this throws until {@link reset}.
   */
  flush(): Promise<void>;
  /** Throws away everything in flight and restarts the timeline, for a seek. */
  reset(startSample?: number): void;
  latency(): LatencyReport;
}

export function createStreamingSeparator(options: StreamingOptions): StreamingSeparator {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const windowSamples = options.windowSamples ?? SEGMENT_SAMPLES;
  const plan = streamPlan(
    windowSamples,
    options.hopSamples ?? Math.round(windowSamples * (1 - NATIVE_OVERLAP)),
  );
  if (plan.segment > options.runner.segmentSamples) {
    throw new Error(
      `a window of ${String(plan.segment)} samples does not fit the runner's segment of ` +
        `${String(options.runner.segmentSamples)}`,
    );
  }

  const buffer = createWindowBuffer(plan.segment, plan.stride);
  const tiling = createBlockTiling(0);
  const takeLeft = new Float32Array(plan.segment);
  const takeRight = new Float32Array(plan.segment);
  const vocalsLeft = new Float32Array(plan.segment);
  const vocalsRight = new Float32Array(plan.segment);
  const instrumentalLeft = new Float32Array(plan.segment);
  const instrumentalRight = new Float32Array(plan.segment);
  const computeMs: number[] = [];

  let vocalsStitch = createStitcher(plan, 2);
  let instrumentalStitch = createStitcher(plan, 2);
  /** Windows run since the last reset, which decides whether a tail exists. */
  let windows = 0;
  /** Where the window the stitcher is holding begins. */
  let held = 0;
  /** Bumped by a reset, so a window still in flight is thrown away. */
  let generation = 0;
  let pumping: Promise<void> | null = null;
  let finishing = false;
  let ended = false;

  const emit = (
    startSample: number,
    vocals: Float32Array,
    instrumental: Float32Array,
    frames: number,
  ): void => {
    tiling.accept(startSample, frames);
    deinterleave(vocals, frames, vocalsLeft, vocalsRight);
    deinterleave(instrumental, frames, instrumentalLeft, instrumentalRight);
    options.onBlock({
      startSample,
      vocals: [vocalsLeft.subarray(0, frames), vocalsRight.subarray(0, frames)],
      instrumental: [instrumentalLeft.subarray(0, frames), instrumentalRight.subarray(0, frames)],
    });
  };

  /** The held window, cut off where the audio actually ended. */
  const finish = (): void => {
    if (windows === 0) {
      return;
    }
    const frames = Math.min(plan.segment, buffer.pushed - held);
    if (frames <= 0) {
      return;
    }
    emit(held, vocalsStitch.finish(), instrumentalStitch.finish(), frames);
  };

  /**
   * Runs windows until none is ready. One of these at a time: the stitcher and
   * the runner are both stateful, so two overlapping drains would interleave
   * windows and tear the stream.
   */
  const drain = async (): Promise<void> => {
    // Yields before anything else so this cannot finish before `pump` has
    // recorded it, which would leave a settled promise standing in for a drain
    // that is no longer running.
    await Promise.resolve();
    try {
      for (;;) {
        // While the stream is open a whole window has to have arrived. While
        // it is closing, anything past the crossfade still needs a window of
        // its own; anything inside the crossfade is already held.
        const ready = finishing ? buffer.pending > plan.fade : buffer.pending >= plan.segment;
        if (!ready) {
          if (finishing) {
            finish();
            finishing = false;
            ended = true;
          }
          return;
        }

        const start = buffer.take(takeLeft, takeRight);
        if (start === null) {
          throw new Error('a window was ready and then had nothing in it');
        }
        const mine = generation;
        const startedAt = performance.now();
        const run = await options.runner.run(takeLeft, takeRight);
        if (mine !== generation) {
          // A seek landed while this window was in the model. Its output
          // belongs to a timeline nobody is listening to any more.
          continue;
        }
        computeMs.push(performance.now() - startedAt);
        if (computeMs.length > COMPUTE_HISTORY) {
          computeMs.shift();
        }

        const vocals = vocalsStitch.push(run.vocals);
        const instrumental = instrumentalStitch.push(run.instrumental);
        windows += 1;
        held = start;
        if (vocals !== null && instrumental !== null) {
          // What the stitcher let go of is the hop before the window just run:
          // its crossfade with this one is what made it final.
          emit(start - plan.stride, vocals, instrumental, plan.stride);
        }
      }
    } finally {
      pumping = null;
    }
  };

  const pump = (): Promise<void> => {
    pumping ??= drain();
    return pumping;
  };

  return {
    plan,

    push(left, right) {
      if (ended) {
        throw new Error('this stream has been flushed; reset() before pushing again');
      }
      buffer.push(left, right);
      return pump();
    },

    flush() {
      if (ended) {
        return Promise.resolve();
      }
      finishing = true;
      return pump();
    },

    reset(startSample = 0) {
      generation += 1;
      buffer.reset(startSample);
      tiling.reset(startSample);
      vocalsStitch = createStitcher(plan, 2);
      instrumentalStitch = createStitcher(plan, 2);
      windows = 0;
      held = startSample;
      finishing = false;
      ended = false;
    },

    latency() {
      return latencyReport({
        windowSamples: plan.segment,
        hopSamples: plan.stride,
        sampleRate,
        computeMs: medianMs(computeMs),
        pushedSamples: buffer.pushed,
        emittedSamples: tiling.end,
      });
    },
  };
}
