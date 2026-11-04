import type { ResetReason } from '../protocol.ts';

/**
 * What a seek, a pause or an ad means for the audio and for the picture.
 *
 * One table, and it is here rather than spread through the content script's
 * listeners because every one of these decisions is a judgement that can be
 * argued with, and arguing with a table is easier than arguing with six
 * `if`s. Pure, so the table is the test.
 *
 * **A pause is the row that changed, and it is the point of the table.** It
 * used to reset, on the reasoning that a separated block belongs to the
 * timeline it was captured on. That reasoning is wrong for a pause, and only
 * for a pause: the audio either side of one is the same song with nothing
 * missing between it, because the capture is fed by the page and a paused page
 * feeds it nothing. Resetting meant that clicking the video — which is how
 * YouTube pauses — cost the entire delay again, eighteen seconds of silence
 * for a click somebody probably made by accident. So a pause holds. The output
 * freezes, the picture freezes, and a resume carries on from the same sample
 * with the same delay, with the paused stretch taken out of both.
 *
 * What is left on the reset list is everything that really does move the
 * person onto another timeline: a jump in the video's own clock, a rate
 * change, the end, an ad boundary, another video. `timeline.ts` is what
 * decides whether a `seeking` event was a jump at all, because the page fires
 * them for things that are not.
 *
 * The picture half of each row is a choice, and worth being honest about. A
 * frame is stamped with the wall instant it was displayed, so the picture
 * needs no resetting at all: eighteen seconds after a seek it would still be
 * showing exactly what the audio is playing, because both are eighteen seconds
 * behind the same clock. What makes it wrong is that it would be eighteen
 * seconds of pre-seek video over silence, which reads as a frozen tab. So the
 * picture comes down when the audio does, the person gets the real video back
 * while there is nothing to sing to, and both go delayed again together.
 *
 * Ads are the one row that changes what is audible. The extension cannot tell
 * an ad from a song, and eighteen seconds of separated advertisement is not
 * worth having, so an ad turns the whole thing off for its duration: the real
 * video comes back, passthrough lets the tab's own audio through undelayed —
 * capture has muted the tab, so without it the ad would be silent — and when
 * it is over both halves prime again.
 */

/** Media events the page already emits, plus the two an ad amounts to. */
export type PageEvent =
  | 'seeking'
  | 'seeked'
  | 'pause'
  | 'play'
  | 'ratechange'
  | 'ended'
  | 'ad-start'
  | 'ad-end';

/** What the audio side is told. */
export type AudioAction =
  /** Nothing. */
  | 'none'
  /** Throw the buffer away and prime again. */
  | 'reset'
  /** Freeze the output and keep everything. */
  | 'hold'
  /** Carry on from the same sample. */
  | 'resume';

export type PictureAction =
  /** Leave it alone. */
  | 'none'
  /** Hold the frame on screen; the page is not moving either. */
  | 'freeze'
  /** Carry on from the held frame, with the pause taken out of the delay. */
  | 'thaw'
  /** Overlay down, real video back. */
  | 'clear'
  /** Overlay down and straight back up, keeping frames from now. */
  | 'reprime';

export interface PageDecision {
  readonly audio: AudioAction;
  /** Why, when the audio is being reset. Null otherwise. */
  readonly reset: ResetReason | null;
  readonly picture: PictureAction;
  /** Whether the tab's own audio should be let through. Null to leave it. */
  readonly passthrough: boolean | null;
}

const DECISIONS: Readonly<Record<PageEvent, PageDecision>> = {
  // A seek is two events. The first throws everything away, the second starts
  // again, and splitting them that way means a long scrub that fires `seeking`
  // repeatedly only primes once, at the end.
  seeking: { audio: 'reset', reset: 'seek', picture: 'clear', passthrough: null },
  seeked: { audio: 'none', reset: null, picture: 'reprime', passthrough: null },
  // Nothing is thrown away and nothing is primed: see above.
  pause: { audio: 'hold', reset: null, picture: 'freeze', passthrough: null },
  play: { audio: 'resume', reset: null, picture: 'thaw', passthrough: null },
  // The stamps survive a rate change — they are wall instants, not media
  // times — but the audio's buffer does not, because every sample after it
  // arrives at a different rate than the ones before it, and a picture that
  // keeps running over eighteen seconds of silence looks broken.
  ratechange: { audio: 'reset', reset: 'ratechange', picture: 'clear', passthrough: null },
  ended: { audio: 'reset', reset: 'ended', picture: 'clear', passthrough: null },
  'ad-start': { audio: 'reset', reset: 'ad', picture: 'clear', passthrough: true },
  'ad-end': { audio: 'reset', reset: 'ad', picture: 'reprime', passthrough: false },
};

export function decidePageEvent(event: PageEvent): PageDecision {
  return DECISIONS[event];
}

/**
 * Whether the picture should be put back up. It should not, however loudly the
 * page says play, if an ad is what is playing or if the audio side is not
 * running: a delayed picture over audio nobody is separating is a frozen tab
 * with extra steps.
 */
export function shouldReprime(options: {
  readonly action: PictureAction;
  readonly inAd: boolean;
  readonly running: boolean;
}): boolean {
  return options.action === 'reprime' && !options.inAd && options.running;
}
