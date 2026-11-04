/**
 * What goes wrong, as something a person reads.
 *
 * Every failure in this app arrives as an `unknown` from a catch: a decode
 * that the browser refused, a write this browser cannot do, a play the
 * browser would not start. Thrown away it becomes a silent dead end, and
 * shown raw it becomes a DOMException name nobody can act on. So each one is
 * tagged with the part of the app it came from, and that tag chooses a plain
 * first line while the original reason is kept for the details underneath.
 *
 * Pure on purpose: the mapping is the part worth testing, and the toast that
 * draws it is not.
 */

export type TroubleArea = 'ingest' | 'analysis' | 'playback' | 'lyrics' | 'storage';

export interface Trouble {
  readonly area: TroubleArea;
  /** The technical reason, as near to what was thrown as it can be put. */
  readonly reason: string;
}

/** What a caught `unknown` has to say for itself. Never empty. */
export function reasonText(cause: unknown): string {
  if (cause instanceof Error) {
    const named = cause.name === '' || cause.name === 'Error' ? '' : `${cause.name}: `;
    return cause.message === '' ? `${named}no reason given`.trim() : `${named}${cause.message}`;
  }
  if (typeof cause === 'string' && cause !== '') {
    return cause;
  }
  return 'no reason given';
}

export function troubleFrom(area: TroubleArea, cause: unknown): Trouble {
  return { area, reason: reasonText(cause) };
}

export interface NoticeText {
  /** One line, in words that say what the person has lost. */
  readonly headline: string;
  /** The reason, for whoever wants it. Null when there is nothing to add. */
  readonly detail: string | null;
}

/**
 * The plain line for each part of the app. Deliberately about what happened
 * to the song rather than about the API that refused: "could not be kept on
 * this device" is actionable, "InvalidStateError" is not.
 */
const HEADLINES: Readonly<Record<TroubleArea, string>> = {
  ingest: 'That file could not be opened',
  analysis: 'Taking the voice out did not finish',
  playback: 'That song could not be played',
  lyrics: 'Reading the lyrics did not finish',
  storage: 'This browser could not keep that on the device',
};

export function describeTrouble(trouble: Trouble): NoticeText {
  return {
    headline: HEADLINES[trouble.area],
    detail: trouble.reason === '' ? null : trouble.reason,
  };
}
