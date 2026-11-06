import type { PracticeNote } from '../audio/practice.ts';

/**
 * What the offscreen document and the practice worker say to each other.
 *
 * The vocal stem crosses once, by transfer, and is never sent back: the
 * worker keeps no session of its own and the offscreen document hands it a
 * copy rather than the array the duet helper also reads. What comes back is a
 * note list, which is small enough to copy.
 */

export type PracticeCommand = {
  readonly type: 'analyze';
  readonly samples: Float32Array;
  readonly sampleRate: number;
};

export type PracticeEvent =
  | { readonly type: 'progress'; readonly progress: number }
  | { readonly type: 'notes'; readonly notes: readonly PracticeNote[] }
  | { readonly type: 'failed'; readonly reason: string };
