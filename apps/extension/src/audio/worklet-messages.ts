/**
 * The two worklets' names, their shapes and what travels down their ports.
 *
 * Both worklets are built as single-file bundles, so they may import this and
 * the pure helpers freely: nothing they pull in survives as an `import` in the
 * file `addModule` is handed. That matters because a worklet is loaded as a
 * module script and support for static imports inside one is not something to
 * rely on.
 */

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
  | { readonly type: 'gain'; readonly target: number; readonly seconds: number }
  | { readonly type: 'flush' };

export interface PlaybackReport {
  readonly type: 'playback';
  readonly readTo: number;
  readonly underrunFrames: number;
  readonly lateFrames: number;
  readonly aheadFrames: number;
  readonly gapFrames: number;
  readonly queuedFrames: number;
}

export type PlaybackEvent = PlaybackReport;
