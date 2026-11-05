/**
 * How far along preparing is, as a number between nought and one.
 *
 * Preparing is three things, in order, and each one owns a slice of the bar:
 *
 * 1. **Reading the audio.** The stream the page reported is fetched and
 *    decoded. Its length is known from the start, so this is a ratio — unless
 *    the stream came with no length, in which case the bar creeps rather than
 *    guessing.
 * 2. **Loading the model.** Twenty-one graph pieces fetched from the packed
 *    extension and compiled. A ratio of pieces, which the runner reports.
 * 3. **Separating it.** The whole track, window by window. The plan gives the
 *    exact number of windows and every finished block is one of them, so this
 *    is the only stage that knows its total for certain — which the old
 *    design's separating stage never did.
 *
 * The slices are judgements about where the waiting is, not predictions: the
 * model load is usually the longest of the three and the download the
 * shortest, and the numbers below say so. There is no countdown here and
 * nothing is extrapolated: the bar moves when something measurably happens.
 *
 * The only estimate offered is for the separating stage, and only once this
 * machine has actually timed a window. It says *about*, because that is what
 * a measured average is.
 *
 * Pure, so the table is the test.
 */

export type PrepareStage = 'download' | 'loading' | 'separating';

/** The stages in the order they happen, which is the order of the bar. */
export const PREPARE_STAGES: readonly PrepareStage[] = ['download', 'loading', 'separating'];

/**
 * Each stage's slice of the bar, in whole percentages. Sums to a hundred.
 *
 * Kept as integers and divided at the end rather than written as fractions,
 * because a bar built by adding 0.10 to 0.40 to 0.50 does not reach one and a
 * progress bar that stops at 0.9999999999999999 is a progress bar with a bug
 * report attached.
 */
const STAGE_PERCENT: Readonly<Record<PrepareStage, number>> = {
  download: 10,
  loading: 40,
  separating: 50,
};

/** The same slices as fractions, which is what the bar is drawn from. */
export const STAGE_WEIGHTS: Readonly<Record<PrepareStage, number>> = {
  download: STAGE_PERCENT.download / 100,
  loading: STAGE_PERCENT.loading / 100,
  separating: STAGE_PERCENT.separating / 100,
};

/**
 * How eagerly a stage that cannot measure itself approaches its top edge. At
 * the guessed duration it is 86% of the way across its slice, at twice the
 * guess 98%, and it never quite arrives: the stage ending is what moves the
 * bar on.
 */
const CREEP = 2;

/** The guessed duration of a stage with nothing to measure, in seconds. */
const CREEP_GUESS_SECONDS = 6;

export interface Pieces {
  readonly loaded: number;
  readonly total: number;
}

/** Where the download has got to, in bytes. */
export interface DownloadFacts {
  readonly doneBytes: number;
  /** Null when the stream reported no length, so nothing to ratio against. */
  readonly totalBytes: number | null;
}

/** What the stages cost, measured, and filled in as each one ends. */
export interface StageTimings {
  downloadSeconds: number | null;
  loadingSeconds: number | null;
  /** One window's compute, which is the unit separation is paid in. */
  windowMs: number | null;
}

export const NO_TIMINGS: StageTimings = {
  downloadSeconds: null,
  loadingSeconds: null,
  windowMs: null,
};

/**
 * What the engine can see. Every field is an observation rather than a plan,
 * which is the whole point: the bar moves when something happens.
 */
export interface PrepareFacts {
  /** Null before the fetch has reported anything. */
  readonly download: DownloadFacts | null;
  /** Graph pieces compiled so far, or null once that stage is over. */
  readonly pieces: Pieces | null;
  readonly windowsDone: number;
  /** Nought until the plan is known, which is what opens the stage. */
  readonly windowsTotal: number;
  /** Seconds since this prepare began, for stages that can only creep. */
  readonly elapsedSeconds: number;
  readonly timings: StageTimings;
}

export interface PrepareProgress {
  readonly stage: PrepareStage;
  /** Nought to one. Never goes backwards; see {@link advanceProgress}. */
  readonly fraction: number;
  /** The graph pieces, while that is what is being waited for. */
  readonly pieces: Pieces | null;
  /**
   * Seconds left, once this machine has timed a window, or null before it
   * has. Call it *about*.
   */
  readonly aboutSeconds: number | null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function ratio(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return clamp01(done / total);
}

/** The first unfinished stage, which is the one the bar is on. */
export function stageOf(facts: PrepareFacts): PrepareStage {
  if (facts.windowsTotal > 0) {
    return 'separating';
  }
  if (facts.pieces !== null) {
    return 'loading';
  }
  return 'download';
}

/** Where a stage's slice of the bar starts and how wide it is. */
export function stageSpan(stage: PrepareStage): { readonly from: number; readonly size: number } {
  let before = 0;
  for (const earlier of PREPARE_STAGES) {
    if (earlier === stage) {
      break;
    }
    before += STAGE_PERCENT[earlier];
  }
  return { from: before / 100, size: STAGE_WEIGHTS[stage] };
}

/** The fraction of the whole bar at `within` of the way through `stage`. */
export function fractionAt(stage: PrepareStage, within: number): number {
  const span = stageSpan(stage);
  return clamp01(span.from + span.size * clamp01(within));
}

/** How far through its own stage, nought to one. */
function withinStage(stage: PrepareStage, facts: PrepareFacts): number {
  switch (stage) {
    case 'download': {
      const download = facts.download;
      if (download === null) {
        return 0;
      }
      if (download.totalBytes !== null && download.totalBytes > 0) {
        return ratio(download.doneBytes, download.totalBytes);
      }
      // No length to ratio against: approach rather than stall.
      return 1 - Math.exp((-CREEP * Math.max(0, facts.elapsedSeconds)) / CREEP_GUESS_SECONDS);
    }
    case 'loading': {
      const pieces = facts.pieces;
      return pieces === null ? 0 : ratio(pieces.loaded, pieces.total);
    }
    case 'separating':
      return ratio(facts.windowsDone, facts.windowsTotal);
  }
}

export function prepareProgress(facts: PrepareFacts): PrepareProgress {
  const stage = stageOf(facts);
  const windowMs = facts.timings.windowMs;
  const aboutSeconds =
    stage === 'separating' && windowMs !== null && windowMs > 0
      ? (Math.max(0, facts.windowsTotal - facts.windowsDone) * windowMs) / 1000
      : null;
  return {
    stage,
    fraction: fractionAt(stage, withinStage(stage, facts)),
    pieces: stage === 'loading' ? facts.pieces : null,
    aboutSeconds: aboutSeconds === null ? null : Math.max(0, aboutSeconds),
  };
}

/**
 * The same progress, never behind where it has already been.
 *
 * Every input here is measured, and measurements wobble. A bar that retreats
 * reads as a fault, so the fraction only ever climbs.
 */
export function advanceProgress(
  previous: PrepareProgress | null,
  next: PrepareProgress,
): PrepareProgress {
  if (previous === null || next.fraction >= previous.fraction) {
    return next;
  }
  return { ...next, fraction: previous.fraction };
}

const STAGE_WORDS: Readonly<Record<PrepareStage, string>> = {
  download: 'Reading the audio',
  loading: 'Loading the model',
  separating: 'Taking the vocal out',
};

/** The one line under the bar. The pieces are named because they are slow. */
export function prepareLabel(progress: PrepareProgress): string {
  const words = STAGE_WORDS[progress.stage];
  const pieces = progress.pieces;
  if (progress.stage !== 'loading' || pieces === null || pieces.total <= 0) {
    return words;
  }
  return `${words}, ${String(pieces.loaded)} of ${String(pieces.total)}`;
}

/**
 * The estimate, in words, or null when there is nothing honest to say. It says
 * *about* because a measured average is about, and it never pretends to be a
 * countdown.
 */
export function aboutText(progress: PrepareProgress): string | null {
  const seconds = progress.aboutSeconds;
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }
  const whole = Math.max(0, Math.round(seconds));
  return whole <= 1 ? 'about a second left' : `about ${String(whole)} s left`;
}

/** The bar's width, as a whole percentage, for a style and for aria. */
export function progressPercent(fraction: number): number {
  return Math.round(clamp01(fraction) * 100);
}
