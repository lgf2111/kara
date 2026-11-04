import type { SourceKind } from '../library/songs.ts';

/**
 * Why a media element would not play, and what to do about it.
 *
 * Two failures matter enough to be decided here rather than in a component.
 *
 * The first is autoplay. Safari will not start a song that nobody asked for,
 * and `play()` rejects with NotAllowedError. Swallowing that leaves a stage
 * that looks like it is playing and is not, so the refusal has to be turned
 * into something on screen.
 *
 * The second is the codec. Safari can open an MP4 whose video track it cannot
 * decode — AV1 on Apple chips before the M3, for one — and the element fails
 * with MEDIA_ERR_SRC_NOT_SUPPORTED. The audio track of the same file is
 * usually fine, so the song can still play and still be separated if the
 * picture is given up.
 *
 * Both are pure functions over what the browser reported, so both can be
 * tested without a browser.
 */

export type PlayRefusal =
  /** The browser wants a gesture first. One press on the stage fixes it. */
  | 'needs-a-tap'
  /** Nothing in the file can be played here. */
  | 'unsupported'
  /** Something else called pause() or changed the source. Not a failure. */
  | 'interrupted'
  | 'unknown';

/** What `play()` rejected with, by the name the browser gave the exception. */
export function readPlayRefusal(cause: unknown): PlayRefusal {
  const name = cause instanceof Error ? cause.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'needs-a-tap';
    case 'NotSupportedError':
      return 'unsupported';
    case 'AbortError':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

export type MediaFailure = 'none' | 'aborted' | 'network' | 'decode' | 'unsupported';

/** `MediaError.code`, which is a number and not an enum anybody can read. */
export function readMediaFailure(code: number | null | undefined): MediaFailure {
  switch (code) {
    case 1:
      return 'aborted';
    case 2:
      return 'network';
    case 3:
      return 'decode';
    case 4:
      return 'unsupported';
    default:
      return 'none';
  }
}

/**
 * The failure as the technical reason behind a notice. Plainer than the code
 * and still specific enough to act on: "this browser has no decoder for it"
 * sends somebody to a different browser, where "error 4" sends them nowhere.
 */
export function describeMediaFailure(failure: MediaFailure): string {
  switch (failure) {
    case 'aborted':
      return 'the browser stopped loading the file';
    case 'network':
      return 'reading the file off this device failed partway through';
    case 'decode':
      return 'the browser could not decode the file, which usually means a damaged track';
    case 'unsupported':
      return 'this browser has no decoder for what is in this file';
    case 'none':
      return 'the browser reported no reason';
  }
}

export type VideoRemedy =
  /** Play the file's sound through an audio element and give up the picture. */
  | 'audio-only'
  /** Say so: nothing here can be salvaged. */
  | 'report'
  /** Not worth a word: the source was swapped or the load was cancelled. */
  | 'ignore';

export interface VideoTrouble {
  readonly kind: SourceKind;
  readonly failure: MediaFailure;
  /** Whether the element had already got a picture out of this file. */
  readonly played: boolean;
}

/**
 * Whether a failed video is worth retrying as sound alone.
 *
 * Only before anything has played. A file that fails after a minute of
 * picture has a damaged track somewhere in the middle, and restarting it as
 * audio would lose the person their place to no purpose; a file that fails
 * at the first frame never had a picture to lose.
 */
export function videoRemedy({ kind, failure, played }: VideoTrouble): VideoRemedy {
  if (failure === 'none' || failure === 'aborted') {
    return 'ignore';
  }
  if (kind !== 'video' || played) {
    return 'report';
  }
  return failure === 'unsupported' || failure === 'decode' ? 'audio-only' : 'report';
}

/** What the stage says when it has dropped the picture. Short, and not a failure. */
export const AUDIO_ONLY_NOTICE =
  'This browser cannot show the picture in this file, so it is playing the sound only.';
