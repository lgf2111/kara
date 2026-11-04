/**
 * The one clock the capture, the separator and the player all read.
 *
 * Audio arrives from the tab in render quanta and leaves, about sixteen
 * seconds later, through a different worklet. Nothing in between can be
 * trusted to say when a sample was captured: `performance.now()` is the main
 * thread's idea of time, the separator works in sample indices with no notion
 * of time at all, and the player needs a moment on the audio device's clock.
 *
 * So the capture worklet stamps each chunk with the `AudioContext` time of the
 * quantum it began in, and this turns those stamps into one line: sample zero
 * was captured at `anchorTime`, and every sample after it one period later. A
 * block that comes back from the separator knows which sample it starts at, so
 * it knows when it was captured, so it knows when to play: capture time plus
 * the delay. Step B's picture delay reads the same number.
 *
 * Pure arithmetic, no Web Audio, so the mapping can be tested against stamps
 * written by hand.
 */

export interface CaptureClock {
  readonly sampleRate: number;
  /** Samples stamped since the last reset. */
  readonly samples: number;
  /** Context time sample zero arrived at, or null before the first chunk. */
  readonly anchorTime: number | null;
  /**
   * Where the last chunk's stamp fell against where the sample count put it.
   * Zero while the capture is sound: a worklet renders exactly one quantum per
   * quantum of context time. It goes non-zero when the audio thread skipped,
   * which is the one way this mapping can quietly stop being true.
   */
  readonly driftSeconds: number;
  /**
   * Takes a chunk's stamp and length, and returns the absolute index of its
   * first sample. The first stamp after a reset anchors the timeline.
   */
  stamp(contextTime: number, frames: number): number;
  /** When a sample was captured, or null while nothing has been stamped. */
  captureTimeOf(sample: number): number | null;
  /** When a sample should be heard, `delaySeconds` after it was captured. */
  playTimeOf(sample: number, delaySeconds: number): number | null;
  /** Throws the timeline away and starts again at sample zero, for a seek. */
  reset(): void;
  /**
   * Keeps every sample counted so far and moves the line to meet the next
   * chunk wherever it lands. This is what a pause is.
   *
   * A pause does not break the timeline: the samples either side of it are
   * the same song with nothing missing between them, because the capture
   * simply stopped being fed. What it does break is the assumption that the
   * sample count and the context clock advance together, and a stretch of
   * context time with no samples in it is not the audio thread skipping — the
   * one thing {@link CaptureClock.driftSeconds} exists to catch. So the line
   * is re-anchored on the first chunk after the pause, and the drift it would
   * otherwise have read is not counted.
   */
  rejoin(): void;
}

export function createCaptureClock(sampleRate: number): CaptureClock {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`a clock needs a positive sample rate, not ${String(sampleRate)}`);
  }

  let samples = 0;
  let anchorTime: number | null = null;
  let driftSeconds = 0;
  /** A pause is waiting to be stitched out of the line. */
  let rejoining = false;

  return {
    sampleRate,
    get samples() {
      return samples;
    },
    get anchorTime() {
      return anchorTime;
    },
    get driftSeconds() {
      return driftSeconds;
    },

    stamp(contextTime, frames) {
      if (!Number.isInteger(frames) || frames < 0) {
        throw new Error(`a chunk of ${String(frames)} frames is not a length`);
      }
      if (!Number.isFinite(contextTime)) {
        throw new Error(`a chunk stamped ${String(contextTime)} has no time on it`);
      }
      const start = samples;
      if (anchorTime === null || rejoining) {
        anchorTime = contextTime - start / sampleRate;
        rejoining = false;
      } else {
        driftSeconds = contextTime - (anchorTime + start / sampleRate);
      }
      samples = start + frames;
      return start;
    },

    captureTimeOf(sample) {
      return anchorTime === null ? null : anchorTime + sample / sampleRate;
    },

    playTimeOf(sample, delaySeconds) {
      return anchorTime === null ? null : anchorTime + sample / sampleRate + delaySeconds;
    },

    reset() {
      samples = 0;
      anchorTime = null;
      driftSeconds = 0;
      rejoining = false;
    },

    rejoin() {
      rejoining = true;
    },
  };
}

/** Steps the delay is rounded up to, so it is a number a person can read. */
const DELAY_STEP_SECONDS = 0.5;

/**
 * How far behind live to sit.
 *
 * The separator says how late its finalised audio is; this adds headroom and
 * rounds up to a half second. The headroom is what keeps the player from
 * running dry when one window costs more than the median, and the rounding is
 * so the number stays put between measurements: step B delays the picture by
 * exactly this, and a delay that twitches is worse than a delay that is
 * slightly too long.
 */
export function chooseDelaySeconds(lagMs: number, marginSeconds = 1.5): number {
  const lag = Number.isFinite(lagMs) ? Math.max(0, lagMs) / 1000 : 0;
  const margin = Number.isFinite(marginSeconds) ? Math.max(0, marginSeconds) : 0;
  return Math.ceil((lag + margin) / DELAY_STEP_SECONDS) * DELAY_STEP_SECONDS;
}
