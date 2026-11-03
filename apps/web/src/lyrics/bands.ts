import { keepFrame, type GroupingOptions, type OcrFrame } from './lines.ts';

/**
 * Finding the strip of the frame the words sit in.
 *
 * This has to be worked out rather than assumed. The node spike ran OCR on
 * whole 1080p frames of a lyric video and read nothing at all: the text was
 * one thin line of small capitals at low contrast, and page segmentation threw
 * it away as noise. Cropped to its own band and upscaled, the same frames read
 * at 92.7 confidence. So: measure how busy each row of a few frames is, keep
 * the rows that are busy in frame after frame, and let OCR judge the handful of
 * candidates that come out.
 *
 * Rows that recur, rather than the busiest rows, because a lyric line is the
 * one thing that stays in the same place for the whole video. Scenery moves,
 * and a title card is busy for a few seconds only.
 *
 * Pure row arithmetic over the energies `pixels.ts` measures, so it is tested
 * on synthetic frames.
 */

export interface Band {
  /** Top of the band, as a fraction of the frame height. */
  readonly top: number;
  /** Bottom of the band, as a fraction of the frame height. */
  readonly bottom: number;
  /** Share of probe frames in which the band's busiest row was busy. */
  readonly recurrence: number;
  /** Mean row energy over the band, as a share of each frame's busiest row. */
  readonly energy: number;
}

export interface BandOptions {
  /** A row is busy at this share of the way from the frame's median row to its busiest. */
  readonly rowThreshold: number;
  /** Rows no further apart than this join one band, so a gap cannot split a line. */
  readonly joinRows: number;
  /** A band thinner than this many rows is noise rather than a line of text. */
  readonly minRows: number;
  /** A band taller than this share of the frame is scenery rather than a line. */
  readonly maxHeightShare: number;
  /** A row must be busy in this share of the frames to count as recurring. */
  readonly minRecurrence: number;
  /** Margin added above and below a band, as a share of the frame height. */
  readonly padShare: number;
}

export const BANDS: BandOptions = {
  rowThreshold: 0.35,
  joinRows: 2,
  minRows: 2,
  maxHeightShare: 0.4,
  minRecurrence: 0.3,
  padShare: 0.02,
};

/**
 * Where a lyric video usually puts its words, for when row energy finds
 * nothing that recurs: a still frame with the line already on it, or a picture
 * busy enough that every row looks like text. OCR still has the last word on
 * which of these, if any, holds anything readable.
 */
export const FALLBACK_BANDS: readonly Band[] = [
  { top: 0.74, bottom: 0.95, recurrence: 0, energy: 0 },
  { top: 0.4, bottom: 0.62, recurrence: 0, energy: 0 },
  { top: 0.05, bottom: 0.26, recurrence: 0, energy: 0 },
];

function round(value: number, places = 3): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale + 0;
}

interface Run {
  first: number;
  last: number;
}

/**
 * Ranks the bands that hold text in frame after frame, best first.
 *
 * @param energies one row-energy array per probe frame, all the same length
 */
export function rankBands(
  energies: readonly Float32Array[],
  options: Partial<BandOptions> = {},
): Band[] {
  const settings = { ...BANDS, ...options };
  const height = energies.find((energy) => energy.length > 0)?.length ?? 0;
  // A frame of a different height is a frame of a different video, so it has
  // no row to contribute and is left out of the count as well.
  const frames = energies.filter((energy) => energy.length === height);
  if (height === 0 || frames.length === 0) {
    return [];
  }

  const busyIn = new Float64Array(height);
  const shareOfPeak = new Float64Array(height);
  for (const energy of frames) {
    const sorted = energy.slice().sort();
    const peak = sorted[height - 1] ?? 0;
    if (!(peak > 0)) {
      // A frame with no edges anywhere votes for no row, and still counts
      // against the recurrence of every row: it is a frame with no words.
      continue;
    }
    const median = sorted[Math.floor(height / 2)] ?? 0;
    const limit = median + settings.rowThreshold * (peak - median);
    for (let y = 0; y < height; y += 1) {
      const value = energy[y] ?? 0;
      shareOfPeak[y] = (shareOfPeak[y] ?? 0) + value / peak;
      if (value >= limit) {
        busyIn[y] = (busyIn[y] ?? 0) + 1;
      }
    }
  }

  const runs: Run[] = [];
  for (let y = 0; y < height; y += 1) {
    if ((busyIn[y] ?? 0) / frames.length < settings.minRecurrence) {
      continue;
    }
    const open = runs[runs.length - 1];
    if (open !== undefined && y - open.last - 1 <= settings.joinRows) {
      open.last = y;
    } else {
      runs.push({ first: y, last: y });
    }
  }

  const bands: Band[] = [];
  for (const run of runs) {
    const rows = run.last - run.first + 1;
    if (rows < settings.minRows || rows > settings.maxHeightShare * height) {
      continue;
    }
    let recurrence = 0;
    let energy = 0;
    for (let y = run.first; y <= run.last; y += 1) {
      recurrence = Math.max(recurrence, (busyIn[y] ?? 0) / frames.length);
      energy += (shareOfPeak[y] ?? 0) / frames.length;
    }
    bands.push({
      top: round(Math.max(0, run.first / height - settings.padShare)),
      bottom: round(Math.min(1, (run.last + 1) / height + settings.padShare)),
      recurrence: round(recurrence),
      energy: round(energy / rows),
    });
  }

  return bands.sort(
    (a, b) => b.recurrence - a.recurrence || b.energy - a.energy || a.top - b.top,
  );
}

/** The bands worth an OCR trial, which is the ranking or the fallback. */
export function candidateBands(
  energies: readonly Float32Array[],
  count: number,
  options: Partial<BandOptions> = {},
): Band[] {
  const ranked = rankBands(energies, options);
  return ranked.length > 0 ? ranked.slice(0, count) : FALLBACK_BANDS.slice(0, count);
}

export interface BandTrial {
  readonly band: Band;
  /** Trial frames whose reading was worth keeping. */
  readonly hits: number;
  /** Mean confidence over those frames, 0 when there were none. */
  readonly confidence: number;
}

/** What OCR made of one band's crops. */
export function scoreBand(
  band: Band,
  readings: readonly OcrFrame[],
  options: Partial<GroupingOptions> = {},
): BandTrial {
  const kept = readings.filter((reading) => keepFrame(reading, options));
  const total = kept.reduce((sum, reading) => sum + reading.confidence, 0);
  return {
    band,
    hits: kept.length,
    confidence: kept.length === 0 ? 0 : round(total / kept.length, 1),
  };
}

/**
 * The band with the most confident hits, or null when none of them read
 * anything. Hits first and confidence second: a band that reads a line in
 * every frame beats one that reads a logo very surely in two.
 */
export function pickBand(trials: readonly BandTrial[]): BandTrial | null {
  const best = [...trials].sort(
    (a, b) => b.hits - a.hits || b.confidence - a.confidence || a.band.top - b.band.top,
  )[0];
  return best === undefined || best.hits === 0 ? null : best;
}
