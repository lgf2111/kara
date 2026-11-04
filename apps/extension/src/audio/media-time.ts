/**
 * Where the page is in the song, sampled, so that the audio half can ask.
 *
 * This file exists because the extension used to have two clocks and believed
 * they were one. The audio was stamped on the `AudioContext` and the picture
 * on `performance.timeOrigin + performance.now()`, and the sentence that held
 * the two together — *a moment captured at instant T is heard at T + delay* —
 * is only true while the page is playing at a steady rate. A YouTube
 * buffering stall breaks it in the worst possible way: the video's own clock
 * stands still while the capture keeps running, so a stretch of silence gets
 * stapled into the middle of the song, every frame after it is matched to
 * audio from before it, and nothing ever recovers.
 *
 * So the clock both halves read is now the video's own: `video.currentTime`.
 * The content script reports `{wallMs, mediaSeconds, playing, rate}` about
 * four times a second and on every media event, and this turns those reports
 * into one question the capture can ask of any instant: **where in the song
 * was the page, and was it moving?** Capture taken while it was not moving is
 * thrown away rather than separated, which is what keeps the processed
 * timeline contiguous in media time.
 *
 * Two honesty notes.
 *
 * A report is a measurement of the past, so an instant past the newest one is
 * extrapolated from it — at most a sampling interval's worth, which is a
 * quarter of a second. And when the newest report is older than
 * {@link STALE_MS} there is nobody reporting at all: a tab with no content
 * script in it, or one whose script was torn out. That is answered with null
 * rather than with a guess, and the caller falls back to trusting the capture,
 * which is what this extension did before any of this existed.
 *
 * Pure, so a stall is a list of numbers written by hand.
 */

/** Where the page was at one instant, as the page itself reported it. */
export interface MediaSample {
  /** `performance.timeOrigin + performance.now()`, which both halves share. */
  readonly wallMs: number;
  /** `video.currentTime`. */
  readonly mediaSeconds: number;
  /** Whether the page claimed to be moving through the song. */
  readonly playing: boolean;
  readonly rate: number;
}

/** Where a stretch of captured audio sits in the song. */
export interface MediaSpan {
  readonly fromSeconds: number;
  readonly toSeconds: number;
  /** How far the song moved across it. Nought through a stall. */
  readonly advancedSeconds: number;
  readonly rate: number;
  /** Whether the page claimed to be playing while it was captured. */
  readonly playing: boolean;
}

/**
 * How long the newest report can be the newest before it stops being
 * evidence. Reports come four times a second, so two seconds of silence means
 * the reporter is gone rather than slow.
 */
export const STALE_MS = 2000;

/** Reports kept. At four a second and on every event, a few seconds of them. */
const HISTORY = 48;

/** Media time that moved by less than this did not move. */
const STILL_SECONDS = 0.004;

/**
 * Slack on what one interval could have advanced by. `currentTime` is read on
 * the main thread between frames, so two readings a quarter of a second apart
 * disagree with the wall clock by a frame or two either way.
 */
const SLACK_SECONDS = 0.1;

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** A report with every field something this file can do arithmetic on. */
function tidy(sample: MediaSample): MediaSample {
  return {
    wallMs: sane(sample.wallMs, 0),
    mediaSeconds: Math.max(0, sane(sample.mediaSeconds, 0)),
    playing: sample.playing,
    rate: Math.max(0, sane(sample.rate, 1)),
  };
}

/** Media time between two reports, interpolated or stepped. */
function between(earlier: MediaSample, later: MediaSample, wallMs: number): number {
  const spanMs = later.wallMs - earlier.wallMs;
  if (spanMs <= 0) {
    return later.mediaSeconds;
  }
  const moved = later.mediaSeconds - earlier.mediaSeconds;
  const could = (spanMs / 1000) * (earlier.playing ? earlier.rate : 0) + SLACK_SECONDS;
  if (moved < -STILL_SECONDS || moved > could) {
    // Nobody played through this interval: it is a jump, or an interval the
    // page spent somewhere this file cannot account for. A step at the later
    // report is the only honest reading — interpolating across a seek would
    // invent a sweep through audio that was never played.
    return wallMs >= later.wallMs ? later.mediaSeconds : earlier.mediaSeconds;
  }
  return earlier.mediaSeconds + moved * ((wallMs - earlier.wallMs) / spanMs);
}

/** Media time after the newest report, which is the only extrapolation here. */
function beyond(newest: MediaSample, wallMs: number): number {
  const ahead = Math.max(0, wallMs - newest.wallMs) / 1000;
  return newest.mediaSeconds + (newest.playing ? ahead * newest.rate : 0);
}

export interface MediaClock {
  readonly samples: number;
  /** The newest report, or null before the page has said anything. */
  readonly newest: MediaSample | null;
  add(sample: MediaSample): void;
  /**
   * Where the page was at a wall instant, or null when nobody is reporting.
   */
  at(wallMs: number): number | null;
  /** The same for a stretch, which is what one captured chunk needs. */
  span(fromWallMs: number, toWallMs: number): MediaSpan | null;
  reset(): void;
}

export function createMediaClock(options: { readonly staleMs?: number } = {}): MediaClock {
  const staleMs = Math.max(0, sane(options.staleMs ?? STALE_MS, STALE_MS));
  let held: MediaSample[] = [];

  /** The newest report at or before an instant, by index, or -1. */
  const indexAt = (wallMs: number): number => {
    for (let index = held.length - 1; index >= 0; index -= 1) {
      const sample = held[index];
      if (sample !== undefined && sample.wallMs <= wallMs) {
        return index;
      }
    }
    return -1;
  };

  const governing = (wallMs: number): MediaSample | null => {
    const index = indexAt(wallMs);
    return held[index === -1 ? 0 : index] ?? null;
  };

  const fresh = (wallMs: number): boolean => {
    const last = held[held.length - 1];
    return last !== undefined && wallMs - last.wallMs <= staleMs;
  };

  const mediaAt = (wallMs: number): number | null => {
    const last = held[held.length - 1];
    if (last === undefined) {
      return null;
    }
    const index = indexAt(wallMs);
    if (index === -1) {
      // Before anything was reported: the oldest reading is the best there is.
      return held[0]?.mediaSeconds ?? null;
    }
    const earlier = held[index];
    const later = held[index + 1];
    if (earlier === undefined) {
      return null;
    }
    return later === undefined ? beyond(earlier, wallMs) : between(earlier, later, wallMs);
  };

  return {
    get samples() {
      return held.length;
    },
    get newest() {
      return held[held.length - 1] ?? null;
    },

    add(sample) {
      const next = tidy(sample);
      const last = held[held.length - 1];
      if (last !== undefined && next.wallMs < last.wallMs) {
        // Out of order, which a dropped message can do. The newest reading is
        // the one worth having, so an older one is no loss.
        return;
      }
      held.push(next);
      if (held.length > HISTORY) {
        held = held.slice(held.length - HISTORY);
      }
    },

    at(wallMs) {
      const asked = sane(wallMs, 0);
      return fresh(asked) ? mediaAt(asked) : null;
    },

    span(fromWallMs, toWallMs) {
      const from = sane(fromWallMs, 0);
      const to = Math.max(from, sane(toWallMs, from));
      if (!fresh(to)) {
        return null;
      }
      const fromSeconds = mediaAt(from);
      const toSeconds = mediaAt(to);
      const sample = governing(from);
      if (fromSeconds === null || toSeconds === null || sample === null) {
        return null;
      }
      return {
        fromSeconds,
        toSeconds,
        advancedSeconds: toSeconds - fromSeconds,
        rate: sample.rate,
        playing: sample.playing,
      };
    },

    reset() {
      held = [];
    },
  };
}
