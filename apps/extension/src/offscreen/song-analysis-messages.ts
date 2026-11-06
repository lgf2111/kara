import type { SongFacts } from '../audio/song-analysis.ts';

/**
 * What the offscreen document and the song-analysis worker say to each other.
 *
 * The three stems cross once, by transfer, already reduced to the analysis
 * rate. They are copies, so cancelling a run — an ad, a stop — never costs the
 * session the arrays it needs for the next attempt. What comes back is a few
 * numbers.
 */

export type SongAnalysisCommand = {
  readonly type: 'analyze';
  /** Bass, other and vocal mixed to mono. */
  readonly harmonic: Float32Array;
  /** The drum stem alone. */
  readonly percussive: Float32Array;
  /** The vocal stem alone. */
  readonly vocals: Float32Array;
  readonly sampleRate: number;
};

export type SongAnalysisEvent =
  | { readonly type: 'progress'; readonly progress: number }
  | { readonly type: 'facts'; readonly facts: SongFacts }
  | { readonly type: 'failed'; readonly reason: string };
