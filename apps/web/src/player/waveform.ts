/**
 * The shape of a song, as bar heights for the audio stage, kept away from Web
 * Audio so it can be tested without a browser: it is handed the samples a
 * stem holds.
 *
 * A song with no picture still needs something to look at, and its own
 * backing stem is the only honest thing to draw. Measured once when the stems
 * are read rather than metered as it plays: a still shape with the played
 * part lit says where the song is as well as a dancing meter, and costs
 * nothing while it plays.
 */

/** Bars across the stage. Enough to read as a song, few enough to stay crisp. */
export const WAVEFORM_BARS = 56;

/** Samples looked at per bar, spread across the stretch it covers. */
const BAR_SAMPLES = 256;

/** The quietest a bar is drawn, so a silent passage is still a line. */
export const WAVEFORM_FLOOR = 0.08;

function barCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

/**
 * One height per bar, 0 to 1: the peak of each stretch of the song, scaled to
 * the loudest of them so a quietly mastered song is not a flat line.
 */
export function waveformBars(
  samples: Float32Array,
  count = WAVEFORM_BARS,
  perBar = BAR_SAMPLES,
): number[] {
  const bars = barCount(count);
  if (bars === 0) {
    return [];
  }
  const span = samples.length / bars;
  // Sampled, not read whole: a four-minute stem is ten million frames and
  // this runs while the person is waiting to press play.
  const step = Math.max(1, Math.floor(span / Math.max(1, Math.floor(perBar))));
  const peaks: number[] = [];
  let loudest = 0;

  for (let bar = 0; bar < bars; bar += 1) {
    const start = Math.floor(bar * span);
    const end = Math.min(samples.length, Math.floor((bar + 1) * span));
    let peak = 0;
    for (let at = start; at < end; at += step) {
      const sample = Math.abs(samples[at] ?? 0);
      if (Number.isFinite(sample) && sample > peak) {
        peak = sample;
      }
    }
    peaks.push(peak);
    loudest = Math.max(loudest, peak);
  }

  return peaks.map((peak) =>
    Math.max(WAVEFORM_FLOOR, loudest === 0 ? 0 : Math.min(1, peak / loudest)),
  );
}

/** How many bars the playhead has passed, so the rest can be drawn dim. */
export function barsPlayed(
  currentSeconds: number,
  durationSeconds: number,
  count: number,
): number {
  const bars = barCount(count);
  if (bars === 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  if (!Number.isFinite(currentSeconds) || currentSeconds <= 0) {
    return 0;
  }
  return Math.min(bars, Math.floor((currentSeconds / durationSeconds) * bars));
}
