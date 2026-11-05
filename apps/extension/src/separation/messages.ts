/**
 * What the offscreen document and the separation worker say to each other.
 *
 * Audio goes one way in each message and always by transfer, so no buffer is
 * copied across the boundary and none is ever shared: the worker hands a block
 * over and forgets it, and the engine writes it into the stem buffers.
 *
 * This is the same engine the web app runs on an uploaded file, driven the
 * same way: the whole track is pushed in chunks, then flushed, and the blocks
 * that come back tile it exactly once.
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
  /** Ends the track: runs what is left and posts the last block, then `done`. */
  | { readonly type: 'flush' }
  | { readonly type: 'close' };

export type SeparatorEvent =
  | { readonly type: 'loading'; readonly loaded: number; readonly total: number }
  | {
      readonly type: 'ready';
      readonly windowSamples: number;
      readonly hopSamples: number;
      /** Which backend the model loaded on, for the debug report. */
      readonly backend: 'webgpu' | 'wasm';
      /** Why that backend was chosen. */
      readonly backendReason: string;
    }
  | {
      readonly type: 'block';
      readonly startSample: number;
      readonly frames: number;
      /**
       * Transferred, in the order `stem-player-messages.ts` names and
       * `audio/stems.ts` owns: drums left and right, bass left and right,
       * other left and right, then vocals left and right. Eight channels,
       * every one as long as the block.
       */
      readonly channels: readonly Float32Array[];
      readonly computeMs: number;
    }
  /** The whole track has been separated: every block is out. */
  | { readonly type: 'done'; readonly samples: number }
  /**
   * The reason is what a person is shown. There is no `unsupported` any more:
   * a file can be separated slowly, so the WASM fallback runs rather than
   * refusing.
   */
  | { readonly type: 'failed'; readonly reason: string; readonly stack?: string };
