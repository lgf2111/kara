/**
 * How much of the timeline has had its stems separated.
 *
 * Separation arrives from the start outwards, so the ready part is always one
 * prefix: nought to the frontier. This is the pure half of the progress-bar
 * overlay; `content/analysis-bar.ts` only draws the number.
 */

/**
 * The fraction of the timeline whose stems are ready, or null when there is
 * nothing useful to show.
 *
 * Null covers both ends: no duration yet, no separated audio yet, and a fully
 * separated track. A full-width gold line would just be permanent decoration
 * once the wait is over.
 */
export function analyzedFraction(
  analyzedSeconds: number | null,
  durationSeconds: number | null,
): number | null {
  if (
    analyzedSeconds === null ||
    durationSeconds === null ||
    !Number.isFinite(analyzedSeconds) ||
    !Number.isFinite(durationSeconds) ||
    analyzedSeconds <= 0 ||
    durationSeconds <= 0
  ) {
    return null;
  }
  const fraction = Math.min(1, Math.max(0, analyzedSeconds / durationSeconds));
  return fraction >= 0.999 ? null : fraction;
}
