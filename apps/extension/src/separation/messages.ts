/**
 * What the offscreen document and the separation worker say to each other.
 *
 * Audio goes one way in each message and always by transfer, so no buffer is
 * copied across the boundary and none is ever shared: the worker hands a block
 * over and forgets it, which is what lets the player own it until its moment
 * has passed.
 */

export type SeparatorCommand =
  | {
      readonly type: 'init';
      /** Where the graph's pieces are, as a URL this context can fetch. */
      readonly weightsBase: string;
      /** Where onnxruntime-web's wasm is. Ends in a slash. */
      readonly runtimePath: string;
      readonly sampleRate: number;
    }
  | {
      readonly type: 'chunk';
      readonly startSample: number;
      readonly left: Float32Array;
      readonly right: Float32Array;
    }
  | { readonly type: 'reset' }
  /**
   * Artificial compute time per window, in milliseconds, so that starvation
   * can be provoked on a machine fast enough never to starve by itself. The
   * debug harness asks for it; nothing in the packed extension does.
   */
  | { readonly type: 'slow'; readonly ms: number }
  | { readonly type: 'close' };

export type SeparatorEvent =
  | { readonly type: 'loading'; readonly loaded: number; readonly total: number }
  | {
      readonly type: 'ready';
      /** What the separator says its finalised audio will be late by. */
      readonly lagMs: number;
      readonly windowSamples: number;
      readonly hopSamples: number;
    }
  | {
      readonly type: 'block';
      readonly startSample: number;
      readonly frames: number;
      /**
       * Transferred, in the order `worklet-messages.ts` names: vocal left and
       * right, then instrumental left and right.
       */
      readonly channels: readonly Float32Array[];
      readonly lagMs: number;
      readonly computeMs: number;
      readonly bufferSamples: number;
    }
  /** No WebGPU, or no shader-f16: there is no fallback that could keep up. */
  | { readonly type: 'unsupported'; readonly reason: string }
  /** The reason is what a person is shown; the stack is for the debug report. */
  | { readonly type: 'failed'; readonly reason: string; readonly stack?: string };
