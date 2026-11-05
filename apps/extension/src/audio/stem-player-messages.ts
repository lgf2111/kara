/**
 * The stem player's name, its shapes and what travels down its port.
 *
 * The worklet is built as a single-file bundle, so it may import this and the
 * pure helpers freely: nothing it pulls in survives as an `import` in the file
 * `addModule` is handed. That matters because a worklet is loaded as a module
 * script and support for static imports inside one is not something to rely
 * on.
 */

import type { FadeShape } from './mix-gain.ts';

export const STEM_PLAYER_PROCESSOR = 'kara-stem-player';

/** The render quantum the worklet assumes, and Web Audio's only size. */
export const QUANTUM = 128;

/** Quanta between reports: about a tenth of a second at 44.1 kHz. */
export const PLAYBACK_REPORT_QUANTA = 34;

/**
 * The stems travel as one block of eight channels: drums, bass, other and
 * vocals in the model's order, each a left and a right together. A stem's left
 * channel is at `2 * index` and its right at `2 * index + 1`, which is the one
 * layout fact the separator, the engine and this worklet all have to agree on.
 * `audio/stems.ts` owns the order; `STEMS` is the name for it everywhere.
 */
export const STEM_CHANNELS = 8;

/** A position change this far, in frames, is a jump rather than a drift. */
export const JUMP_FRAMES = Math.round(0.05 * 44100);

export type StemPlayerCommand =
  /**
   * The stems, once, before anything plays. Transferred, so the offscreen
   * document no longer holds them: eight channels, all the same length.
   */
  | { readonly type: 'stems'; readonly channels: readonly Float32Array[] }
  /**
   * The other way to hand stems over: allocate eight channels of the whole
   * track, then fill them block by block as the separation reaches them.
   *
   * The player can start on a block before the next one exists, which is what
   * lets the vocal switch go live while the rest of the song is still being
   * separated. `stem-block` is only accepted in order; the frontier is
   * therefore one number rather than a list of holes.
   */
  | { readonly type: 'begin'; readonly frames: number }
  | {
      readonly type: 'stem-block';
      /** Absolute frame where this block starts; must be the old frontier. */
      readonly startSample: number;
      /** The eight channels, in the order above, copied into the track. */
      readonly channels: readonly Float32Array[];
    }
  /**
   * One gain per stem, in `STEMS` order, each between nought and one. The
   * whole set travels rather than one level: a mix is a balance, and a message
   * that changed one stem would let two contexts disagree about the others.
   */
  | {
      readonly type: 'mix';
      readonly gains: readonly number[];
      readonly seconds: number;
    }
  /**
   * The two separated voices, once the local helper has finished them. Both
   * are mono at the context rate and the same length as the track. The
   * player owns them from here; the single vocal stem is muted by the engine
   * while these are active.
   */
  | { readonly type: 'duet'; readonly voice1: Float32Array; readonly voice2: Float32Array }
  /** One gain per voice, in Voice 1 / Voice 2 order. */
  | { readonly type: 'duet-mix'; readonly gains: readonly number[]; readonly seconds: number }
  /** Exchange which stream is Voice 1; the controls stay where they are. */
  | { readonly type: 'duet-swap' }
  /** Drop the pair and return to the single vocal stem. */
  | { readonly type: 'duet-clear' }
  /**
   * The gain everything leaves through: nought for the video's own sound,
   * one for the stems, and the ramps between them are the toggle.
   */
  | {
      readonly type: 'master';
      readonly target: number;
      readonly seconds: number;
      readonly shape: FadeShape;
    }
  /** The key is applied by the pitch-shift node after this one; this is its delay. */
  | { readonly type: 'latency'; readonly samples: number }
  /**
   * Where the video is right now. The worklet anchors its head here and
   * advances it at `rate` between anchors, so a seek is just the next anchor.
   */
  | { readonly type: 'anchor'; readonly mediaSeconds: number; readonly rate: number }
  /**
   * Whether the video is moving. Not playing means frozen where it is, which
   * is what a pause is now: nothing is thrown away, nothing is primed.
   */
  | { readonly type: 'playing'; readonly playing: boolean }
  | { readonly type: 'stop' };

export interface StemPlayerReport {
  readonly type: 'playback';
  /** The absolute frame being read, or -1 while it is playing nothing. */
  readonly playFrame: number;
  /** Frames the track holds, so the caller can read the position as time. */
  readonly length: number;
}
