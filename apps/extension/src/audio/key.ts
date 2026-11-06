/**
 * The key control: what it is allowed to be, what a button press makes of it,
 * and what it is called on screen.
 *
 * The shift itself is the Signalsmith Stretch worklet the offscreen document
 * puts after the player; the limit here is a product choice rather than an
 * import of the library's own range. Six either way is where a key change is
 * still useful for singing, and it keeps the control to whole steps on a
 * pair of buttons. The panel and the popup are built into the content script
 * and a page, and neither needs to load a pitch-shifting library to find out
 * what a button should say.
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

/** Which path the stems take, and how far ahead the player must read. */
export interface KeyRoute {
  /** Whether the shifter is out of the path at this key. */
  readonly bypass: boolean;
  /** The latency the player has to pay for, in whole frames. */
  readonly latencySamples: number;
}

/**
 * The graph the key asks for.
 *
 * At the original key there is nothing to shift, so the stems go straight to
 * the output and the player reads the video's position, not the shifter's
 * delay. Any other key goes through Signalsmith and pays its reported
 * latency. Pure, so the routing is a test rather than a wiring detail.
 */
export function keyRoute(semitones: unknown, shifterLatencySamples: unknown): KeyRoute {
  const key = clampKey(semitones);
  const latency =
    typeof shifterLatencySamples === 'number' && Number.isFinite(shifterLatencySamples)
      ? Math.max(0, Math.round(shifterLatencySamples))
      : 0;
  return key === 0
    ? { bypass: true, latencySamples: 0 }
    : { bypass: false, latencySamples: latency };
}
