/**
 * The five things this extension can be doing, and what moves it between them.
 *
 * - `idle`: nothing is captured. The tab plays to the person as it always did.
 * - `priming`: the tab is captured and muted, the separator is filling its
 *   first windows, and there is nothing yet to play. About sixteen seconds.
 * - `live`: separated audio is coming out, delayed by the agreed amount.
 * - `unsupported`: this machine cannot run the model fast enough to be live at
 *   all. There is no WASM fallback here, so this is a dead end with a reason.
 * - `error`: something went wrong that a retry might survive.
 *
 * Two things in the table are worth saying out loud. `unsupported` does not
 * answer to anything but `stop`, because a missing WebGPU adapter is a fact
 * about the machine and pressing the button again will not change it. And
 * `reset` is ignored unless something was running, so a stray seek event from
 * a tab nobody is capturing cannot start a prime.
 *
 * Pure, so the table is the test.
 */

export type Status = 'idle' | 'priming' | 'live' | 'unsupported' | 'error';

export interface StatusState {
  readonly status: Status;
  /** Why, in words, for `unsupported` and `error`. Null otherwise. */
  readonly reason: string | null;
}

export type StatusEvent =
  | { readonly type: 'start' }
  /** The first separated audio reached the player. */
  | { readonly type: 'primed' }
  /** A seek, a pause or a rate change: what is buffered is worthless. */
  | { readonly type: 'reset' }
  | { readonly type: 'stop' }
  | { readonly type: 'unsupported'; readonly reason: string }
  | { readonly type: 'error'; readonly reason: string };

export const IDLE: StatusState = { status: 'idle', reason: null };

export function nextStatus(state: StatusState, event: StatusEvent): StatusState {
  switch (event.type) {
    case 'stop':
      return IDLE;
    case 'unsupported':
      return { status: 'unsupported', reason: event.reason };
    case 'error':
      // A machine that cannot do this at all has already said so, and that is
      // the more useful of the two things to be told.
      return state.status === 'unsupported'
        ? state
        : { status: 'error', reason: event.reason };
    case 'start':
      return state.status === 'unsupported' ? state : { status: 'priming', reason: null };
    case 'primed':
      return state.status === 'priming' || state.status === 'live'
        ? { status: 'live', reason: null }
        : state;
    case 'reset':
      return state.status === 'priming' || state.status === 'live'
        ? { status: 'priming', reason: null }
        : state;
  }
}

/**
 * Seconds of priming left, for a tab that would like to be told. Counted from
 * when the capture started against the delay the separator asked for, so it
 * reaches zero exactly when the first delayed sample is due.
 */
export function primingSecondsLeft(
  startedAt: number,
  now: number,
  delaySeconds: number,
): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || !Number.isFinite(delaySeconds)) {
    return 0;
  }
  return Math.max(0, delaySeconds - (now - startedAt) / 1000);
}
