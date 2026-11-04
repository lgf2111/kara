/**
 * The six things this extension can be doing, and what moves it between them.
 *
 * - `idle`: nothing is captured. The tab plays to the person as it always did.
 * - `priming`: the tab is captured and muted, the separator is filling its
 *   first windows, and there is nothing yet to play. `progress.ts` is how long
 *   that is and how far along it is.
 * - `live`: separated audio is coming out, delayed by the agreed amount.
 * - `catching-up`: the delay was not enough — a window started costing more
 *   than it did at the start of the song — so it has grown, and the output is
 *   making up the difference. `audio/delay-plan.ts` is the arithmetic and why
 *   this state exists at all: what it replaced was silence for the rest of the
 *   song, counted in millions of starved frames and never recovered from.
 * - `paused`: the page is paused, so the output and the picture are frozen
 *   where they are. Nothing has been thrown away, and a resume carries on from
 *   the same sample with the same delay.
 * - `unsupported`: this machine cannot run the model fast enough to be live at
 *   all. There is no WASM fallback here, so this is a dead end with a reason.
 * - `error`: something went wrong that a retry might survive.
 *
 * Three things in the table are worth saying out loud.
 *
 * `unsupported` does not answer to anything but `stop`, because a missing
 * WebGPU adapter is a fact about the machine and pressing the button again
 * will not change it.
 *
 * `reset` is ignored unless something was running, so a stray seek event from
 * a tab nobody is capturing cannot start a prime.
 *
 * And `paused` remembers what it was doing, because a pause in the middle of
 * priming has to go back to priming and a pause in the middle of a song has to
 * go back to the song. That is the whole reason this state exists rather than
 * being a reset: a pause used to throw the buffer away and prime the entire
 * delay again, which is eighteen seconds of silence for a click on the video.
 *
 * Pure, so the table is the test.
 */

export type Status =
  | 'idle'
  | 'priming'
  | 'live'
  | 'catching-up'
  | 'paused'
  | 'unsupported'
  | 'error';

export interface StatusState {
  readonly status: Status;
  /** Why, in words, for `unsupported` and `error`. Null otherwise. */
  readonly reason: string | null;
  /** What a resume goes back to. Only ever set while paused. */
  readonly resumeTo?: 'priming' | 'live';
}

/** Whether audio is coming out, catching up or not. */
export function isAudible(status: Status): boolean {
  return status === 'live' || status === 'catching-up';
}

export type StatusEvent =
  | { readonly type: 'start' }
  /** The first separated audio reached the player. */
  | { readonly type: 'primed' }
  /** A seek, a rate change or an ad: what is buffered is worthless. */
  | { readonly type: 'reset' }
  /** The delay has grown and the output is making up the difference. */
  | { readonly type: 'catch-up' }
  | { readonly type: 'caught-up' }
  /** The page paused. Everything is kept; nothing moves. */
  | { readonly type: 'hold' }
  | { readonly type: 'resume' }
  | { readonly type: 'stop' }
  | { readonly type: 'unsupported'; readonly reason: string }
  | { readonly type: 'error'; readonly reason: string };

export const IDLE: StatusState = { status: 'idle', reason: null };

/** Whether the capture is doing something a pause or a reset could affect. */
export function isRunning(status: Status): boolean {
  return (
    status === 'priming' || status === 'live' || status === 'catching-up' || status === 'paused'
  );
}

/** What a pause goes back to, which is never the catching up it interrupted. */
function resumeFor(status: Status): 'priming' | 'live' | null {
  if (status === 'priming') {
    return 'priming';
  }
  // Catching up is a thing in progress rather than a state to come back to: a
  // pause gives the output all the time it needed, so a resume is simply live.
  return isAudible(status) ? 'live' : null;
}

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
      if (state.status === 'paused') {
        // The moment the first block was due went by while the page was
        // paused. Nothing is audible yet, but a resume goes to a song now.
        return { status: 'paused', reason: null, resumeTo: 'live' };
      }
      return state.status === 'priming' || isAudible(state.status)
        ? { status: 'live', reason: null }
        : state;
    case 'catch-up':
      // Only something audible can starve. Priming has not started playing and
      // has nothing to make up.
      return isAudible(state.status) ? { status: 'catching-up', reason: null } : state;
    case 'caught-up':
      return state.status === 'catching-up' ? { status: 'live', reason: null } : state;
    case 'reset':
      if (state.status === 'paused') {
        return { status: 'paused', reason: null, resumeTo: 'priming' };
      }
      return state.status === 'priming' || isAudible(state.status)
        ? { status: 'priming', reason: null }
        : state;
    case 'hold': {
      if (state.status === 'paused') {
        return state;
      }
      const back = resumeFor(state.status);
      return back === null ? state : { status: 'paused', reason: null, resumeTo: back };
    }
    case 'resume':
      return state.status === 'paused'
        ? { status: state.resumeTo ?? 'priming', reason: null }
        : state;
  }
}
