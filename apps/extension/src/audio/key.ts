/**
 * The key control: what it is allowed to be, what a button press makes of it,
 * and what it is called on screen.
 *
 * The shift itself is `apps/web/src/dsp/pitch-shift.ts`, shared with the web
 * app, and the limit here is a copy of its `QUALITY_SEMITONES` rather than an
 * import of it: the panel and the popup are built into the content script and
 * a page, and neither has any business pulling a Fourier transform in to find
 * out what a button should say. `test/key.test.ts` holds the two sides to the
 * same number.
 *
 * Whole semitones, because every surface that sets this is a pair of buttons
 * and the shifter is happy with fractions nobody can ask for. Six either way,
 * because that is where a phase vocoder stops sounding like the song.
 *
 * Pure, so the words are the test.
 */

export const KEY_MIN = -6;
export const KEY_MAX = 6;

/** Where a person who has never touched it starts, and where reset goes. */
export const KEY_DEFAULT = 0;

/** A key inside the range, in whole semitones, whatever it is handed. */
export function clampKey(semitones: unknown): number {
  if (typeof semitones !== 'number' || !Number.isFinite(semitones)) {
    return KEY_DEFAULT;
  }
  return Math.min(KEY_MAX, Math.max(KEY_MIN, Math.round(semitones)));
}

/** What a minus or plus button lands on, which stops at the ends. */
export function nudgeKey(semitones: number, step: number): number {
  return clampKey(clampKey(semitones) + Math.round(step));
}

/** Whether a button has anywhere left to go, so it can be disabled. */
export function canNudge(semitones: number, step: number): boolean {
  return nudgeKey(semitones, step) !== clampKey(semitones);
}

/**
 * The one line the control wears. `Original key` rather than `Key 0`, because
 * zero is not a key somebody chose: it is the song as it was recorded, and
 * saying so is how a person knows they have not left it somewhere.
 */
export function keyLabel(semitones: number): string {
  const key = clampKey(semitones);
  if (key === 0) {
    return 'Original key';
  }
  return key > 0 ? `Key +${String(key)}` : `Key −${String(-key)}`;
}
