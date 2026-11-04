import type { JobPlan } from './job.ts';

/**
 * The arithmetic behind live separation, with no model anywhere near it.
 *
 * Three jobs, all of them pure enough to test with a synthetic signal:
 *
 * - gathering whatever sized chunks a capture hands over into the fixed
 *   windows the model takes, and remembering where each window sits on the
 *   absolute timeline
 * - checking that the blocks coming out tile that timeline with no gap and
 *   nothing counted twice
 * - saying how far behind live the result is, which is the number a player
 *   needs in order to delay the picture by the same amount
 *
 * streaming.ts puts these together with a segment runner. Keeping them apart
 * means the tiling can be proved without a GPU in the room.
 */

/**
 * A window and hop as the stitcher wants them. `fade` is what two neighbouring
 * windows share, which is the crossfade.
 *
 * `total` has no meaning for a stream that has not ended, so it is zero: a
 * live capture has no segment count until it stops.
 */
export function streamPlan(windowSamples: number, hopSamples: number): JobPlan {
  if (!Number.isInteger(windowSamples) || windowSamples < 1) {
    throw new Error(
      `the window must be a positive whole number of samples, not ${String(windowSamples)}`,
    );
  }
  if (!Number.isInteger(hopSamples) || hopSamples < 1) {
    throw new Error(
      `the hop must be a positive whole number of samples, not ${String(hopSamples)}`,
    );
  }
  if (hopSamples > windowSamples) {
    throw new Error(
      `a hop of ${String(hopSamples)} past a window of ${String(windowSamples)} would skip audio`,
    );
  }
  return {
    segment: windowSamples,
    stride: hopSamples,
    fade: windowSamples - hopSamples,
    total: 0,
  };
}

/**
 * Live samples on their way into windows.
 *
 * Push whatever arrives; take a window whenever one is wanted. The cursor
 * always moves by exactly one hop, because the blocks a stitcher releases are
 * one hop long each and the timeline only tiles if the two agree.
 *
 * A take with less than a whole window pending zero-pads the rest, which is
 * what ends a stream. It also puts the buffer somewhere a later push would
 * contradict, since the cursor has moved past audio that never arrived: call
 * {@link WindowBuffer.reset} before pushing again.
 */
export interface WindowBuffer {
  /** Absolute index of the next window's first sample. */
  readonly cursor: number;
  /** Samples at or after the cursor that have arrived. */
  readonly pending: number;
  /** Absolute index one past the last sample pushed. */
  readonly pushed: number;
  push(left: Float32Array, right: Float32Array): void;
  /**
   * Writes the window at the cursor into the targets, zero-filling whatever
   * has not arrived, and moves the cursor on by one hop. Returns the window's
   * absolute first sample, or null when nothing is pending.
   */
  take(left: Float32Array, right: Float32Array): number | null;
  /** Drops everything and restarts the timeline at `startSample`. */
  reset(startSample: number): void;
}

export function createWindowBuffer(windowSamples: number, hopSamples: number): WindowBuffer {
  const plan = streamPlan(windowSamples, hopSamples);
  let capacity = plan.segment + plan.stride;
  let left = new Float32Array(capacity);
  let right = new Float32Array(capacity);
  let used = 0;
  let cursor = 0;
  let pushed = 0;

  const grow = (needed: number): void => {
    if (needed <= capacity) {
      return;
    }
    let next = capacity;
    while (next < needed) {
      next *= 2;
    }
    const widerLeft = new Float32Array(next);
    const widerRight = new Float32Array(next);
    widerLeft.set(left.subarray(0, used));
    widerRight.set(right.subarray(0, used));
    left = widerLeft;
    right = widerRight;
    capacity = next;
  };

  return {
    get cursor() {
      return cursor;
    },
    get pending() {
      return used;
    },
    get pushed() {
      return pushed;
    },

    push(chunkLeft, chunkRight) {
      if (chunkLeft.length !== chunkRight.length) {
        throw new Error(
          `a chunk brought ${String(chunkLeft.length)} left samples and ` +
            `${String(chunkRight.length)} right`,
        );
      }
      if (chunkLeft.length === 0) {
        return;
      }
      grow(used + chunkLeft.length);
      left.set(chunkLeft, used);
      right.set(chunkRight, used);
      used += chunkLeft.length;
      pushed += chunkLeft.length;
    },

    take(intoLeft, intoRight) {
      if (intoLeft.length < plan.segment || intoRight.length < plan.segment) {
        throw new Error(
          `a window needs ${String(plan.segment)} samples of room, not ` +
            `${String(Math.min(intoLeft.length, intoRight.length))}`,
        );
      }
      if (used === 0) {
        return null;
      }
      const span = Math.min(used, plan.segment);
      intoLeft.set(left.subarray(0, span));
      intoRight.set(right.subarray(0, span));
      intoLeft.fill(0, span);
      intoRight.fill(0, span);

      const start = cursor;
      const drop = Math.min(plan.stride, used);
      left.copyWithin(0, drop, used);
      right.copyWithin(0, drop, used);
      used -= drop;
      cursor += plan.stride;
      return start;
    },

    reset(startSample) {
      used = 0;
      cursor = startSample;
      pushed = startSample;
    },
  };
}

/**
 * The order finalised blocks have to come out in: each one starting exactly
 * where the last one ended, so the stream a player reads has no silent gap and
 * no sample played twice.
 */
export interface BlockTiling {
  /** Absolute index one past the last sample accepted. */
  readonly end: number;
  /** Takes the next block, or says what is wrong with it. */
  accept(startSample: number, frames: number): void;
  reset(startSample: number): void;
}

export function createBlockTiling(startSample = 0): BlockTiling {
  let end = startSample;
  return {
    get end() {
      return end;
    },
    accept(start, frames) {
      if (frames <= 0) {
        throw new Error(`a block of ${String(frames)} frames has nothing in it`);
      }
      if (start !== end) {
        throw new Error(
          start < end
            ? `a block at ${String(start)} repeats audio already finalised up to ${String(end)}`
            : `a block at ${String(start)} leaves a gap after ${String(end)}`,
        );
      }
      end = start + frames;
    },
    reset(at) {
      end = at;
    },
  };
}

export interface LatencyReport {
  /** Samples pushed that no finalised block covers yet. */
  readonly bufferSamples: number;
  /** What one window costs to separate, measured. */
  readonly computeMs: number;
  /** How far behind live a player has to sit. This is the picture delay. */
  readonly totalLagMs: number;
}

export interface LatencyInput {
  readonly windowSamples: number;
  readonly hopSamples: number;
  readonly sampleRate: number;
  /** Typical milliseconds for one window, usually a median of what was seen. */
  readonly computeMs: number;
  readonly pushedSamples: number;
  readonly emittedSamples: number;
}

/**
 * Where the lag comes from.
 *
 * A window at `t` is only final once the window at `t + hop` has been run,
 * which needs audio out to `t + hop + window`. So the frontier of finalised
 * audio trails live by one window, and it moves in hop-sized jumps rather than
 * smoothly: a player that sat exactly one window behind would run dry between
 * jumps. One window plus one hop plus the time a window takes to compute is
 * the delay at which it never does.
 *
 * Which means the hop has to stay longer than `computeMs`, or the separation
 * falls further behind with every window and no fixed delay saves it. That
 * floor is how far the hop can come down; the window is the other half of the
 * trade, and shortening it costs separation quality rather than compute, since
 * the graph's segment is fixed whatever fraction of it is real audio.
 */
export function latencyReport(input: LatencyInput): LatencyReport {
  const samples = input.windowSamples + input.hopSamples;
  return {
    bufferSamples: Math.max(0, input.pushedSamples - input.emittedSamples),
    computeMs: input.computeMs,
    totalLagMs: (samples / input.sampleRate) * 1000 + input.computeMs,
  };
}

/** Splits interleaved stereo into two channels, `frames` of each. */
export function deinterleave(
  interleaved: Float32Array,
  frames: number,
  left: Float32Array,
  right: Float32Array,
): void {
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = interleaved[frame * 2] ?? 0;
    right[frame] = interleaved[frame * 2 + 1] ?? 0;
  }
}
