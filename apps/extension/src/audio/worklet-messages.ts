/**
 * The two worklets' names, their shapes and what travels down their ports.
 *
 * Both worklets are built as single-file bundles, so they may import this and
 * the pure helpers freely: nothing they pull in survives as an `import` in the
 * file `addModule` is handed. That matters because a worklet is loaded as a
 * module script and support for static imports inside one is not something to
 * rely on.
 */

import type { FadeShape } from './mix-gain.ts';

export const CAPTURE_PROCESSOR = 'kara-capture';
export const PLAYBACK_PROCESSOR = 'kara-playback';

/** The render quantum both worklets assume, and Web Audio's only size. */
export const QUANTUM = 128;

/**
 * Frames the capture gathers before handing a chunk over: about 93 ms, which
 * is eleven messages a second and a sixtieth of a window.
 */
export const CAPTURE_CHUNK_FRAMES = 4096;

/** Quanta between playback reports: about a quarter of a second. */
export const PLAYBACK_REPORT_QUANTA = 86;

/**
 * The four channels of a separated block, in the order the ring holds them and
 * the order the separation worker sends them.
 */
export const VOCALS_LEFT = 0;
export const VOCALS_RIGHT = 1;
export const INSTRUMENTAL_LEFT = 2;
export const INSTRUMENTAL_RIGHT = 3;
export const BLOCK_CHANNELS = 4;

export interface CaptureChunk {
  readonly type: 'chunk';
  /** Context time of the quantum this chunk began in. */
  readonly time: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

export type CaptureEvent = CaptureChunk;

/** Drops a half-gathered chunk, so a reset does not staple old audio on. */
export type CaptureCommand = { readonly type: 'flush' };

export type PlaybackCommand =
  /** Context time at which sample zero of this timeline is due. */
  | { readonly type: 'epoch'; readonly epoch: number }
  | {
      readonly type: 'block';
      readonly startFrame: number;
      readonly channels: readonly Float32Array[];
    }
  /** The vocal's gain: the mode switch and the guide level. */
  | { readonly type: 'gain'; readonly target: number; readonly seconds: number }
  /**
   * The gain everything leaves through: the mute of a pause, the fade in on
   * going live, and the arriving half of a crossfade. `at` is a context time
   * the ramp is armed for, which is how a fade is lined up with the epoch.
   */
  | {
      readonly type: 'master';
      readonly target: number;
      readonly seconds: number;
      readonly shape: FadeShape;
      readonly at?: number;
    }
  /**
   * The key, in semitones, applied to everything that leaves: instrumental,
   * guide vocal and original alike. The shifter's latency is the same at zero
   * as at anything else, so this never moves the audio against the picture.
   */
  | { readonly type: 'transpose'; readonly semitones: number }
  /**
   * The page paused. Output fades out and then stops moving: nothing is read,
   * so no frame is counted late, missing or early for the time nobody was
   * listening.
   */
  | { readonly type: 'hold'; readonly seconds: number }
  /**
   * The page played. The epoch moves forward by however long the hold lasted,
   * which is what makes the resume carry on from the same sample rather than
   * from wherever the clock has got to.
   */
  | { readonly type: 'resume'; readonly seconds: number }
  | { readonly type: 'flush' };

export interface PlaybackReport {
  readonly type: 'playback';
  readonly readTo: number;
  readonly underrunFrames: number;
  readonly lateFrames: number;
  readonly aheadFrames: number;
  readonly gapFrames: number;
  readonly queuedFrames: number;
  /**
   * Seconds the output has spent frozen since the last flush, summed. The
   * player measures it because the player is the one holding the clock the
   * epoch is on, and the picture has to be shifted by exactly the same amount
   * or the words stop matching the mouth.
   */
  readonly heldSeconds: number;
}

export type PlaybackEvent = PlaybackReport;
