import type { JobPlan } from './job.ts';

/**
 * Joins overlapping segments into one continuous stream.
 *
 * Each segment overlaps the previous one by `plan.fade` frames. The stitcher
 * holds the previous segment back as a tail, crossfades the next segment's
 * head into it, and only then releases the part that can no longer change.
 * That held-back tail is the whole of the resumable state: persist it and the
 * sample offset, and a later run continues without a seam.
 *
 * Frames are interleaved, `channels` values per frame.
 */
export interface Stitcher {
  readonly channels: number;
  /** The segment held back, interleaved. Persist this to resume. */
  readonly tail: Float32Array<ArrayBuffer>;
  hasTail(): boolean;
  /**
   * Takes the next segment and returns the frames that are now final, or null
   * for the first segment, which has nothing before it to release. The
   * returned buffer is reused: write it before pushing again.
   */
  push(segment: Float32Array): Float32Array<ArrayBuffer> | null;
  /** Everything still held back once there are no more segments. */
  finish(): Float32Array<ArrayBuffer>;
  /** Adopts a tail saved by an earlier run. */
  restore(tail: Float32Array): void;
}

export function createStitcher(plan: JobPlan, channels: number): Stitcher {
  const tail = new Float32Array(plan.segment * channels);
  const released = new Float32Array(plan.stride * channels);
  let primed = false;

  return {
    channels,
    tail,
    hasTail() {
      return primed;
    },
    push(segment) {
      if (!primed) {
        tail.set(segment.subarray(0, tail.length));
        primed = true;
        return null;
      }

      released.set(tail.subarray(0, plan.stride * channels));

      // Crossfade the incoming head against the overlap the tail still holds,
      // writing the blend into the tail so it becomes the new held segment.
      const head = new Float32Array(plan.segment * channels);
      head.set(segment.subarray(0, head.length));
      for (let frame = 0; frame < plan.fade; frame += 1) {
        const blend = plan.fade > 1 ? frame / (plan.fade - 1) : 1;
        for (let channel = 0; channel < channels; channel += 1) {
          const at = frame * channels + channel;
          const previous = tail[plan.stride * channels + at] ?? 0;
          head[at] = previous * (1 - blend) + (head[at] ?? 0) * blend;
        }
      }
      tail.set(head);
      return released;
    },
    finish() {
      return tail;
    },
    restore(saved) {
      if (saved.length !== tail.length) {
        throw new Error(`tail is ${String(saved.length)} long, expected ${String(tail.length)}`);
      }
      tail.set(saved);
      primed = true;
    },
  };
}

/**
 * Frames that are final after `segments` pushes, not counting the flush. Used
 * to keep the job's sample count and the stem files in step.
 */
export function finalisedFrames(plan: JobPlan, segments: number): number {
  return Math.max(0, segments - 1) * plan.stride;
}

/** Frames in the whole output once every segment has been pushed and flushed. */
export function totalFrames(plan: JobPlan, segments: number): number {
  return finalisedFrames(plan, segments) + (segments > 0 ? plan.segment : 0);
}
