/**
 * How far behind live to sit, and what to do when that turns out not to be
 * far enough.
 *
 * The delay used to be chosen once and then defended as a virtue: a number
 * fixed at the first block, never moved, because the picture is held back by
 * exactly this and a delay that twitches is worse than one slightly too long.
 * That reasoning is still right about twitching and was wrong about the rest.
 * A four-minute run proves it: compute per window rises from 2.2 s to 3.2 s as
 * the GPU warms and the page competes for it, the lag passes the delay, and
 * the player's read head crosses the frontier of finalised audio. After that
 * nothing recovers, because a block that arrives for frames already read is
 * dropped as late — so every following block is dropped too, and the output is
 * silence for the rest of the song while the counters climb into the millions.
 *
 * So two decisions live here instead of one constant.
 *
 * **Where to start.** One window plus one hop is structural; what a window
 * costs to compute is a fact about this GPU. The margin on top is a fraction
 * of that cost rather than a fixed second and a half, because a machine that
 * takes three seconds a window is a machine whose windows vary by more than
 * one that takes two.
 *
 * **When to grow.** The delay may only grow, never shrink, and only during a
 * song — a shrink would move the picture forwards, which is the one direction
 * a picture must never go. Growth is by the measured shortfall plus a margin,
 * rounded up to a half second, capped, so that one adjustment is enough rather
 * than ten in a row. What the person hears is a short mute and the words
 * *catching up*, which is the honest version of what used to be silence for
 * ever.
 *
 * Pure, so the arithmetic is the test.
 */

/** Steps the delay is rounded up to, so it is a number a person can read. */
export const DELAY_STEP_SECONDS = 0.5;

/** The least headroom worth having, whatever a window costs. */
export const MIN_MARGIN_SECONDS = 1.5;

/**
 * And how much of a window's compute time to add on top of it. Three
 * quarters: at 2.2 s a window that is the 1.65 s this started life with, and
 * at 3.2 s it is 2.4 s, which is about what the overrun came to.
 */
export const MARGIN_PER_COMPUTE = 0.75;

/**
 * As far as the delay may ever grow. It is not a taste judgement: the player's
 * ring holds a fixed number of seconds of separated audio, and everything
 * between the real lag and the delay is queued in it, so a delay far past the
 * lag would overflow the ring and drop the blocks it was meant to protect.
 * `offscreen/pipeline.ts` holds the ring to a length that covers this.
 */
export const MAX_DELAY_SECONDS = 30;

/**
 * How short the audio has to fall before it is worth a mute and a jump. A
 * tenth of a second of underrun is a dropped quantum or two and recovers by
 * itself; a sixth is the stream genuinely behind.
 */
export const SHORTFALL_SECONDS = 0.15;

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Up to the next half second, so the number stays put between measurements. */
export function roundUpDelay(seconds: number): number {
  const asked = Math.max(0, sane(seconds, 0));
  return Math.ceil(asked / DELAY_STEP_SECONDS) * DELAY_STEP_SECONDS;
}

/** The headroom for a machine that costs this much per window. */
export function marginSeconds(computeMs: number | null): number {
  const compute = computeMs === null ? 0 : Math.max(0, sane(computeMs, 0)) / 1000;
  return Math.max(MIN_MARGIN_SECONDS, compute * MARGIN_PER_COMPUTE);
}

export interface InitialDelayInput {
  /** What the separator says its finalised audio is late by. */
  readonly reportedLagMs: number;
  /** What the first block actually came to, measured on the capture clock. */
  readonly measuredLagMs: number;
  /** Median milliseconds one window costs on this machine, if it is known. */
  readonly computeMs: number | null;
}

/**
 * The delay to start a song at. Both lags describe the same thing and the
 * larger is the one that has to be survived.
 */
export function initialDelaySeconds(input: InitialDelayInput): number {
  const lagMs = Math.max(
    0,
    Math.max(sane(input.reportedLagMs, 0), sane(input.measuredLagMs, 0)),
  );
  return Math.min(MAX_DELAY_SECONDS, roundUpDelay(lagMs / 1000 + marginSeconds(input.computeMs)));
}

/**
 * How thin the queue of separated audio ahead of the output may get before
 * the delay is too small. A second: blocks arrive about six seconds apart, so
 * the queue sawtooths between the headroom and the headroom plus a hop, and
 * its floor is the headroom. A floor under a second is a stream about to
 * starve on the next window that runs long.
 */
export const QUEUE_FLOOR_SECONDS = 1;

export interface ShortfallInput {
  /** Frames the player asked for that nothing had written, since last asked. */
  readonly underrunFrames: number;
  readonly sampleRate: number;
  /** How late the latest block was for its own moment, in seconds. */
  readonly blockLateSeconds: number;
  /** Separated frames written and not yet played: the headroom, in frames. */
  readonly queuedFrames: number;
  readonly queueFloorSeconds?: number;
}

/**
 * How much more delay the audio needs, in seconds, from the three things that
 * can say.
 *
 * What the output could not play is the most certain and the least useful: by
 * then the person has heard the hole. How late blocks are arriving for their
 * own moment is next. The one worth acting on is the queue: it is how much
 * separated audio is waiting ahead of the output, so it falls before anything
 * is audible, and the amount it has fallen below its floor is exactly how much
 * further behind live the player has to sit.
 *
 * The largest wins, because any one of them alone will run the output dry.
 */
export function shortfallSeconds(input: ShortfallInput): number {
  const rate = Math.max(1, sane(input.sampleRate, 1));
  const starved = Math.max(0, sane(input.underrunFrames, 0)) / rate;
  const late = Math.max(0, sane(input.blockLateSeconds, 0));
  const floor = Math.max(0, sane(input.queueFloorSeconds ?? QUEUE_FLOOR_SECONDS, 0));
  const thin = Math.max(0, floor - Math.max(0, sane(input.queuedFrames, 0)) / rate);
  return Math.max(starved, late, thin);
}

export interface GrowthInput {
  readonly delaySeconds: number;
  readonly shortfallSeconds: number;
  readonly computeMs: number | null;
  readonly maxSeconds?: number;
}

/**
 * The delay after catching up, which is never smaller than the one before it
 * and never past the cap. A shortfall too small to bother with gives back the
 * delay unchanged, so the caller can ask on every report.
 */
export function grownDelaySeconds(input: GrowthInput): number {
  const delay = Math.max(0, sane(input.delaySeconds, 0));
  const shortfall = Math.max(0, sane(input.shortfallSeconds, 0));
  const cap = Math.max(delay, sane(input.maxSeconds ?? MAX_DELAY_SECONDS, MAX_DELAY_SECONDS));
  if (shortfall < SHORTFALL_SECONDS) {
    return delay;
  }
  const wanted = roundUpDelay(delay + shortfall + marginSeconds(input.computeMs));
  return Math.min(cap, Math.max(delay, wanted));
}

/** Whether what was measured is worth a mute and a jump at all. */
export function needsCatchUp(seconds: number): boolean {
  return Math.max(0, sane(seconds, 0)) >= SHORTFALL_SECONDS;
}

/** One change of delay, for the debug report and the harness. */
export interface DelayChange {
  readonly atMs: number;
  readonly delaySeconds: number;
  readonly reason: 'first-block' | 'catch-up';
  /** How much it grew by, which is nought for the first one. */
  readonly addedSeconds: number;
}
