/**
 * How far along getting ready is, as a number between nought and one.
 *
 * This file exists because the thing it replaces lied. Preparing used to show
 * a countdown from the delay the separator asked for, which assumed that the
 * only thing standing between pressing the button and hearing something was
 * the delay. It is not. Four things happen in order, and on a first prime the
 * first of them is the longest:
 *
 * 1. **Loading the model.** Twenty-one graph pieces are fetched from the
 *    packed extension and compiled for the GPU. Nothing else can start until
 *    that is done, and audio captured in the meantime is dropped.
 * 2. **Listening to the first window.** The separator cannot run until it has
 *    a whole window, which is 7.8 s of audio at the model's own segment.
 * 3. **Separating it.** The first window is only final once the next one has
 *    run, so the first block comes back a hop and a compute later.
 * 4. **Filling the delay.** The first block fixes the delay and the epoch, and
 *    there is a last stretch of waiting before the moment that block is due.
 *
 * A countdown over that comes out wrong in both directions: it froze at 15.5 s
 * through ten seconds of model loading, then sat at zero for the twelve
 * seconds that were actually left. So there is no countdown here. There is a
 * fraction, built from what has measurably happened, and each stage owns a
 * slice of the bar:
 *
 * | Stage | The bar |
 * | --- | --- |
 * | loading | 0% to 45% |
 * | listening | 45% to 70% |
 * | separating | 70% to 85% |
 * | filling | 85% to 100% |
 *
 * The slices are judgements about where the waiting is, not predictions. Three
 * of the four stages know exactly what they are waiting for — pieces
 * compiled, seconds of audio heard, seconds until the epoch — so their part of
 * the bar is a ratio. Separating does not: how long a window costs is a fact
 * about this GPU that is not known until it has done one. That stage therefore
 * approaches its top edge rather than reaching it, so a machine slower than
 * the guess keeps seeing movement instead of a bar that appears stuck.
 *
 * A prime that is not the first starts at the listening stage, and so at 45%,
 * because the model is already loaded and that is honestly less work left.
 *
 * Nothing in here guesses at a time. A seconds estimate is only offered once
 * the stages it covers have actually been timed on this machine, which on a
 * first prime means not at all until the last stage — and the view that shows
 * it says *about*, because that is what it is.
 *
 * Pure, so the table is the test.
 */

export type PrepareStage = 'loading' | 'listening' | 'separating' | 'filling';

/** The stages in the order they happen, which is the order of the bar. */
export const PREPARE_STAGES: readonly PrepareStage[] = [
  'loading',
  'listening',
  'separating',
  'filling',
];

/**
 * Each stage's slice of the bar, in whole percentages. Sums to a hundred.
 *
 * Kept as integers and divided at the end rather than written as fractions,
 * because a bar built by adding 0.45 to 0.25 to 0.15 does not reach one and a
 * progress bar that stops at 0.9999999999999999 is a progress bar with a bug
 * report attached.
 */
const STAGE_PERCENT: Readonly<Record<PrepareStage, number>> = {
  loading: 45,
  listening: 25,
  separating: 15,
  filling: 15,
};

/** The same slices as fractions, which is what the bar is drawn from. */
export const STAGE_WEIGHTS: Readonly<Record<PrepareStage, number>> = {
  loading: STAGE_PERCENT.loading / 100,
  listening: STAGE_PERCENT.listening / 100,
  separating: STAGE_PERCENT.separating / 100,
  filling: STAGE_PERCENT.filling / 100,
};

/**
 * How eagerly an estimated stage approaches its top edge. At the guessed
 * duration it is 86% of the way across its slice, at twice the guess 98%, and
 * it never quite arrives: the stage ending is what moves the bar on.
 */
const CREEP = 2;

/** The model's own window, in seconds, which is what stage two waits for. */
export const WINDOW_SECONDS = 7.8;

export interface Pieces {
  readonly loaded: number;
  readonly total: number;
}

/** How long each stage took, measured, or null where it has not been yet. */
export type StageSeconds = Readonly<Record<PrepareStage, number | null>>;

export const NO_TIMINGS: StageSeconds = {
  loading: null,
  listening: null,
  separating: null,
  filling: null,
};

/**
 * What the pipeline can see. Every field is an observation rather than a
 * plan, which is the whole point: the bar moves when something happens.
 */
export interface PrepareFacts {
  /** Graph pieces compiled so far, or null before the first report. */
  readonly modelPieces: Pieces | null;
  /** Seconds since this prime began, which is the model's stage. */
  readonly loadingSeconds: number;
  /**
   * Seconds of audio heard since the separator was ready, or null while it is
   * still loading. Non-null is what says the model's stage is over.
   */
  readonly listenedSeconds: number | null;
  /** Seconds of audio the separator needs before it can run anything. */
  readonly windowSeconds: number;
  /** Seconds spent on the first window, or null until it has been heard. */
  readonly separatingSeconds: number | null;
  /** What that is expected to cost: a hop, plus a window's compute. */
  readonly expectedSeparateSeconds: number;
  /** Seconds since the first block came back, or null before it did. */
  readonly fillingSeconds: number | null;
  /** Seconds between that block arriving and the moment it is due. */
  readonly fillSeconds: number;
  /** What the stages cost last time, which is the only estimate offered. */
  readonly timings: StageSeconds;
}

export interface PrepareProgress {
  readonly stage: PrepareStage;
  /** Nought to one. Never goes backwards; see {@link advanceProgress}. */
  readonly fraction: number;
  /** The graph pieces, while that is what is being waited for. */
  readonly pieces: Pieces | null;
  /**
   * Seconds left, totalled from stages this machine has actually timed, or
   * null when any stage ahead has never been timed. Call it *about*.
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

/** Which stage the facts are describing, which is the first unfinished one. */
export function stageOf(facts: PrepareFacts): PrepareStage {
  if (facts.listenedSeconds === null) {
    return 'loading';
  }
  // Checked newest first: once the delay is being filled, the two stages
  // before it are over whatever their own numbers still say.
  if (facts.fillingSeconds !== null) {
    return 'filling';
  }
  if (facts.separatingSeconds !== null) {
    return 'separating';
  }
  return 'listening';
}

/** How far through its own stage, nought to one. */
function withinStage(stage: PrepareStage, facts: PrepareFacts): number {
  switch (stage) {
    case 'loading':
      return facts.modelPieces === null
        ? 0
        : ratio(facts.modelPieces.loaded, facts.modelPieces.total);
    case 'listening':
      return ratio(facts.listenedSeconds ?? 0, facts.windowSeconds);
    case 'separating': {
      // Approached, not reached: what a window costs is not known until this
      // machine has done one, and a bar that stalls reads as a fault.
      const spent = facts.separatingSeconds ?? 0;
      const expected = facts.expectedSeparateSeconds;
      if (!Number.isFinite(spent) || !Number.isFinite(expected) || expected <= 0) {
        return 0;
      }
      return 1 - Math.exp((-CREEP * Math.max(0, spent)) / expected);
    }
    case 'filling':
      return ratio(facts.fillingSeconds ?? 0, facts.fillSeconds);
  }
}

/** Seconds this machine has spent in the stage it is in. */
function spentIn(stage: PrepareStage, facts: PrepareFacts): number {
  switch (stage) {
    case 'loading':
      return facts.loadingSeconds;
    case 'listening':
      return facts.listenedSeconds ?? 0;
    case 'separating':
      return facts.separatingSeconds ?? 0;
    case 'filling':
      return facts.fillingSeconds ?? 0;
  }
}

/**
 * Seconds left in this stage, or null when nothing here can say.
 *
 * Two of the four know exactly: listening is waiting for a fixed span of
 * audio, and filling is waiting for a moment already fixed. The other two are
 * only as good as the last time this machine did them.
 */
function remainingIn(stage: PrepareStage, facts: PrepareFacts): number | null {
  switch (stage) {
    case 'listening':
      return Math.max(0, facts.windowSeconds - (facts.listenedSeconds ?? 0));
    case 'filling':
      return Math.max(0, facts.fillSeconds - (facts.fillingSeconds ?? 0));
    case 'loading':
    case 'separating': {
      const measured = facts.timings[stage];
      return measured === null ? null : Math.max(0, measured - spentIn(stage, facts));
    }
  }
}

/**
 * Seconds until there is something to hear, or null while any stage ahead has
 * never been timed on this machine. Never a countdown: it is recomputed from
 * what has happened, and it is allowed to go up.
 */
export function aboutSeconds(stage: PrepareStage, facts: PrepareFacts): number | null {
  const here = remainingIn(stage, facts);
  if (here === null) {
    return null;
  }
  let total = here;
  for (const later of PREPARE_STAGES.slice(PREPARE_STAGES.indexOf(stage) + 1)) {
    const measured = facts.timings[later];
    if (measured === null) {
      return null;
    }
    total += measured;
  }
  return total;
}

export function prepareProgress(facts: PrepareFacts): PrepareProgress {
  const stage = stageOf(facts);
  return {
    stage,
    fraction: fractionAt(stage, withinStage(stage, facts)),
    pieces: stage === 'loading' ? facts.modelPieces : null,
    aboutSeconds: aboutSeconds(stage, facts),
  };
}

/**
 * The same progress, never behind where it has already been.
 *
 * Every input here is measured, and measurements wobble: the guess at what a
 * window costs is replaced by a better one, a clock is read a moment later
 * than the stage changed. A bar that retreats reads as a fault, so the
 * fraction only ever climbs. A reset is what starts it again, by passing null.
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
  loading: 'Loading the model',
  listening: 'Listening to the first few seconds',
  separating: 'Taking the vocal out',
  filling: 'Filling the delay',
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
 * *about* because a measured average of two stages is about, and it never
 * pretends to be a countdown.
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
