/**
 * The six things this extension can be doing, and what moves it between them.
 *
 * - `idle`: nothing is running. The video plays as it always did.
 * - `preparing`: the video's audio is being read, decoded and separated. The
 *   video itself plays on untouched — there is nothing different to hear yet.
 *   `progress.ts` is how far along that is.
 * - `ready`: the stems are separated and held in memory. The vocal toggle is
 *   live: `original` plays the video's own sound, `instrumental` mutes the
 *   video and plays the stems in its place, synced to the video's clock. Seek
 *   anywhere, any time: the whole track is in hand.
 * - `paused`: the video paused, so the stems hold where they are. Nothing is
 *   lost, and a resume carries on from the same place.
 * - `unsupported`: the audio could not be read, or this machine cannot run the
 *   model. A dead end with a reason.
 * - `error`: something went wrong that a retry might survive.
 *
 * The old design had seven states because it had a delay to defend: priming,
 * live, catching up. All three are gone. There is nothing to catch up to and
 * no arrival to wait for, so preparing goes straight to ready, and a pause is
 * the only other state a running session can be in.
 *
 * Pure, so the table is the test.
 */

export type Status = 'idle' | 'preparing' | 'ready' | 'paused' | 'unsupported' | 'error';

export interface StatusState {
  readonly status: Status;
  /** Why, in words, for `unsupported` and `error`. Null otherwise. */
  readonly reason: string | null;
  /** What a resume goes back to. Only ever set while paused. */
  readonly resumeTo?: 'ready';
}

export type StatusEvent =
  | { readonly type: 'start' }
  /** The stems are separated and the toggle is live. */
  | { readonly type: 'prepared' }
  /** The video paused: the stems hold where they are. */
  | { readonly type: 'hold' }
  /** And carry on from the same place. */
  | { readonly type: 'resume' }
  | { readonly type: 'stop' }
  | { readonly type: 'unsupported'; readonly reason: string }
  | { readonly type: 'error'; readonly reason: string };

export const IDLE: StatusState = { status: 'idle', reason: null };

/** Whether the session is doing something a media report could matter to. */
export function isRunning(status: Status): boolean {
  return status === 'preparing' || status === 'ready' || status === 'paused';
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
      return state.status === 'unsupported' ? state : { status: 'preparing', reason: null };
    case 'prepared':
      // The stems being ready does not make a paused video play: it lands in
      // paused with something to go back to.
      return state.status === 'preparing' || state.status === 'paused'
        ? state.status === 'paused'
          ? { status: 'paused', reason: null, resumeTo: 'ready' }
          : { status: 'ready', reason: null }
        : state;
    case 'hold':
      if (state.status === 'paused') {
        return state;
      }
      return state.status === 'ready'
        ? { status: 'paused', reason: null, resumeTo: 'ready' }
        : state;
    case 'resume':
      return state.status === 'paused'
        ? { status: state.resumeTo ?? 'ready', reason: null }
        : state;
  }
}
