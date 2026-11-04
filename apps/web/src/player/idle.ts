/**
 * When the overlays go away, as a state machine over one clock reading.
 *
 * A KTV room wants the picture, not the furniture: once a song is playing and
 * nobody has touched anything for a moment, the bars and the cursor should
 * leave. The rule is small but it has three ways in (a hand, a key, the song
 * stopping) and one of them is a timer, so it lives here as a pure step
 * function rather than as three effects that each hold half the answer.
 *
 * The caller supplies the clock. `performance.now()` in the browser, plain
 * numbers in a test.
 */

/** Idle this long while playing and the overlays leave. */
export const IDLE_HIDE_MS = 2500;

export interface IdleState {
  /** Whether the overlays and the cursor are on show. */
  readonly shown: boolean;
  readonly playing: boolean;
  /** The clock reading when something last happened. */
  readonly sinceMs: number;
}

export type IdleEvent =
  /** A hand, a finger or a key: anything that means somebody is there. */
  | { readonly kind: 'activity'; readonly atMs: number }
  /** The clock, checked against the last activity. */
  | { readonly kind: 'tick'; readonly atMs: number }
  | { readonly kind: 'playing'; readonly playing: boolean; readonly atMs: number };

function toFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Nothing playing, everything on show. */
export function idleAtRest(atMs = 0): IdleState {
  return { shown: true, playing: false, sinceMs: toFinite(atMs) };
}

/**
 * The next state. Returns the state it was given when nothing changed, so a
 * caller can compare by identity and not redraw on every tick.
 */
export function idleStep(
  state: IdleState,
  event: IdleEvent,
  holdMs = IDLE_HIDE_MS,
): IdleState {
  switch (event.kind) {
    case 'activity':
      return { shown: true, playing: state.playing, sinceMs: toFinite(event.atMs) };
    case 'playing': {
      if (event.playing === state.playing) {
        return state;
      }
      // Both ways round show them again: starting a song is the moment to see
      // what the controls say, and a paused song keeps them for good.
      return { shown: true, playing: event.playing, sinceMs: toFinite(event.atMs) };
    }
    case 'tick': {
      // A paused song keeps its controls however long nobody touches them:
      // the only reason to hide them is that there is something to watch.
      const shown = !state.playing || toFinite(event.atMs) - state.sinceMs < holdMs;
      return shown === state.shown ? state : { ...state, shown };
    }
  }
}
