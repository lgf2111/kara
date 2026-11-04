import { decideContinuity, type Continuity } from './discontinuity.ts';
import type { MediaSpan } from './media-time.ts';

/**
 * The bridge between a sample index and a place in the song.
 *
 * The separator counts in samples from zero and knows nothing else. The
 * picture is stamped with media time, the player has to say where in the song
 * its output has reached, and a block that comes back has only its own sample
 * index to say what it is. So every captured chunk that is kept leaves an
 * entry here, and what comes out is the two directions anybody needs:
 * **which audio to keep**, and **where in the song a processed sample sits.**
 *
 * The important word is *kept*. Audio captured while the song was not moving —
 * paused, buffering, waiting, an ad — never reaches the separator, so the
 * processed timeline has no holes in it: processed sample N is always one
 * sample of song later than processed sample N − 1. That is the whole repair.
 * The old arrangement fed the separator everything, so a thirty-second
 * buffering stall put thirty seconds of silence in the middle of the song and
 * moved every frame after it out of step with the words by exactly that much.
 *
 * Why anchors rather than one line. At a steady rate, media time is a
 * straight function of the sample index, so one anchor would do. What bends
 * the line is a stretch of discarded capture: after it, the next kept sample
 * carries on in the song from where the last kept sample left off, while the
 * sample index has advanced by nothing. So an anchor is written whenever where
 * the page says it is has drifted from where this mapping thought it was by
 * more than {@link TOLERANCE_SECONDS} — which is after every discard, and
 * never while a song is simply playing.
 *
 * The sample index is not counted here. It is the capture clock's, which is
 * the one thing that knows a chunk's moment on the audio device's clock, and
 * which is advanced only for kept chunks for exactly this reason. Passing it
 * in rather than keeping a second count is what stops the two disagreeing.
 *
 * Pure, so a buffering stall is a list of spans.
 */

/** Where one processed sample is known to sit in the song. */
export interface MediaAnchor {
  readonly sample: number;
  readonly mediaSeconds: number;
  /** The page's rate while this stretch was captured. */
  readonly rate: number;
}

export type ChunkVerdict =
  | {
      readonly kind: 'keep';
      readonly startSample: number;
      readonly frames: number;
      readonly mediaSeconds: number;
      /** Whether this chunk had to bend the line, which a discard does. */
      readonly anchored: boolean;
    }
  | {
      readonly kind: 'drop';
      readonly frames: number;
      /** Whether the page admitted to not playing, or claimed it was. */
      readonly stalled: boolean;
    }
  | {
      readonly kind: 'jump';
      readonly fromSeconds: number;
      readonly toSeconds: number;
    };

/**
 * How far the page's reading may differ from this mapping's before an anchor
 * is written. Fifty milliseconds is more than the interpolation's own slack
 * and less than a frame and a half of picture.
 */
export const TOLERANCE_SECONDS = 0.05;

/**
 * Anchors kept. One is written per discarded stretch, so a song full of
 * buffering holds a few dozen; this is the cap past which the oldest go,
 * which only costs the ability to place samples the player read long ago.
 */
const MAX_ANCHORS = 512;

export interface OfferInput {
  /** The processed sample this chunk would start at. */
  readonly startSample: number;
  readonly frames: number;
  /** Where the page says it was, or null when nobody is reporting. */
  readonly span: MediaSpan | null;
  /**
   * What to use for a song position when nobody is reporting: the capture's
   * own clock, in seconds. A tab with no content script in it — which is any
   * tab but YouTube's — still gets separated audio this way, with a timeline
   * that is its own capture rather than the page's.
   */
  readonly fallbackSeconds: number;
}

export interface MediaMap {
  readonly anchors: readonly MediaAnchor[];
  readonly keptFrames: number;
  readonly droppedFrames: number;
  /** Seconds of capture thrown away because the song was not moving. */
  readonly droppedSeconds: number;
  readonly jumps: number;
  /** Whether the page has ever been seen moving since the last reset. */
  readonly started: boolean;
  offer(input: OfferInput): ChunkVerdict;
  /** Where a processed sample sits in the song, or null before the first. */
  mediaOf(sample: number): number | null;
  reset(): void;
}

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function createMediaMap(
  sampleRate: number,
  options: { readonly jumpSeconds?: number; readonly toleranceSeconds?: number } = {},
): MediaMap {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`a map needs a positive sample rate, not ${String(sampleRate)}`);
  }
  const tolerance = Math.max(0, sane(options.toleranceSeconds ?? TOLERANCE_SECONDS, 0));

  let anchors: MediaAnchor[] = [];
  let keptFrames = 0;
  let droppedFrames = 0;
  let droppedSeconds = 0;
  let jumps = 0;

  const anchorAt = (sample: number): MediaAnchor | null => {
    for (let index = anchors.length - 1; index >= 0; index -= 1) {
      const anchor = anchors[index];
      if (anchor !== undefined && anchor.sample <= sample) {
        return anchor;
      }
    }
    // Before the first anchor: its own line, run backwards, is the best there
    // is, and only the player's first quantum ever asks.
    return anchors[0] ?? null;
  };

  const mediaOf = (sample: number): number | null => {
    const anchor = anchorAt(sample);
    if (anchor === null) {
      return null;
    }
    return anchor.mediaSeconds + ((sample - anchor.sample) / sampleRate) * anchor.rate;
  };

  const anchor = (sample: number, mediaSeconds: number, rate: number): void => {
    anchors.push({ sample, mediaSeconds, rate });
    if (anchors.length > MAX_ANCHORS) {
      anchors = anchors.slice(anchors.length - MAX_ANCHORS);
    }
  };

  return {
    get anchors() {
      return anchors;
    },
    get keptFrames() {
      return keptFrames;
    },
    get droppedFrames() {
      return droppedFrames;
    },
    get droppedSeconds() {
      return droppedSeconds;
    },
    get jumps() {
      return jumps;
    },
    get started() {
      return anchors.length > 0;
    },

    offer(input) {
      const frames = Math.max(0, Math.round(sane(input.frames, 0)));
      const startSample = Math.max(0, Math.round(sane(input.startSample, 0)));
      const span = input.span;

      if (span === null) {
        // Nobody to ask. The capture's own clock is the timeline, which is
        // what this extension ran on before the page was ever consulted.
        const seconds = sane(input.fallbackSeconds, 0);
        const was = mediaOf(startSample);
        const bend = was === null || Math.abs(seconds - was) > tolerance;
        if (bend) {
          anchor(startSample, seconds, 1);
        }
        keptFrames += frames;
        return { kind: 'keep', startSample, frames, mediaSeconds: seconds, anchored: bend };
      }

      const chunkSeconds = (frames / sampleRate) * Math.max(0, span.rate);
      const expected = mediaOf(startSample);
      // With nothing kept yet there is nothing to be discontinuous with, so
      // the only question is whether the page is moving at all. Asking it of
      // its own position answers exactly that.
      const verdict: Continuity = decideContinuity({
        expectedSeconds: expected ?? span.fromSeconds,
        actualSeconds: span.fromSeconds,
        advancedSeconds: span.advancedSeconds,
        chunkSeconds,
        ...(options.jumpSeconds === undefined ? {} : { jumpSeconds: options.jumpSeconds }),
      });

      if (verdict === 'standing-still') {
        droppedFrames += frames;
        droppedSeconds += frames / sampleRate;
        return { kind: 'drop', frames, stalled: span.playing };
      }
      if (verdict === 'jumped') {
        jumps += 1;
        return {
          kind: 'jump',
          fromSeconds: expected ?? span.fromSeconds,
          toSeconds: span.fromSeconds,
        };
      }

      const bend = expected === null || Math.abs(span.fromSeconds - expected) > tolerance;
      if (bend) {
        anchor(startSample, span.fromSeconds, Math.max(0.01, span.rate));
      }
      keptFrames += frames;
      return {
        kind: 'keep',
        startSample,
        frames,
        mediaSeconds: span.fromSeconds,
        anchored: bend,
      };
    },

    mediaOf,

    reset() {
      anchors = [];
      keptFrames = 0;
      droppedFrames = 0;
      droppedSeconds = 0;
      jumps = 0;
    },
  };
}
