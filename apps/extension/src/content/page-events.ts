import type { ResetReason } from '../protocol.ts';

/**
 * What a seek, a pause or an ad means for the audio and for the picture.
 *
 * One table, and it is here rather than spread through the content script's
 * listeners because every one of these decisions is a judgement that can be
 * argued with, and arguing with a table is easier than arguing with six
 * `if`s. Pure, so the table is the test.
 *
 * The audio half of each row is forced. A separated block belongs to the
 * timeline it was captured on, so a seek, a pause, a resume or a rate change
 * makes every block in flight worthless, and the only answer is to throw them
 * away and prime again. The pipeline has accepted those four resets since step
 * A; nothing here is new to it.
 *
 * The picture half is a choice, and worth being honest about. A frame is
 * stamped with the wall instant it was displayed, so the picture needs no
 * resetting at all: eighteen seconds after a seek it would still be showing
 * exactly what the audio is playing, because both are eighteen seconds behind
 * the same clock. What makes it wrong is that it would be eighteen seconds of
 * pre-seek video over silence, which reads as a frozen tab. So the picture
 * comes down when the audio does, the person gets the real video back while
 * there is nothing to sing to, and both go delayed again together.
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

export type PictureAction =
  /** Leave it alone. */
  | 'none'
  /** Hold the frame on screen; the page is not moving either. */
  | 'freeze'
  /** Overlay down, real video back. */
  | 'clear'
  /** Overlay down and straight back up, keeping frames from now. */
  | 'reprime';

export interface PageDecision {
  /** What to tell the audio side, or null to tell it nothing. */
  readonly reset: ResetReason | null;
  readonly picture: PictureAction;
  /** Whether the tab's own audio should be let through. Null to leave it. */
  readonly passthrough: boolean | null;
}

const DECISIONS: Readonly<Record<PageEvent, PageDecision>> = {
  // A seek is two events. The first throws everything away, the second starts
  // again, and splitting them that way means a long scrub that fires `seeking`
  // repeatedly only primes once, at the end.
  seeking: { reset: 'seek', picture: 'clear', passthrough: null },
  seeked: { reset: null, picture: 'reprime', passthrough: null },
  pause: { reset: 'pause', picture: 'freeze', passthrough: null },
  play: { reset: 'play', picture: 'reprime', passthrough: null },
  // The stamps survive a rate change — they are wall instants, not media
  // times — but the audio's buffer does not, and a picture that keeps running
  // over eighteen seconds of silence looks broken.
  ratechange: { reset: 'ratechange', picture: 'clear', passthrough: null },
  ended: { reset: 'pause', picture: 'clear', passthrough: null },
  'ad-start': { reset: 'seek', picture: 'clear', passthrough: true },
  'ad-end': { reset: 'seek', picture: 'reprime', passthrough: false },
};

export function decidePageEvent(event: PageEvent): PageDecision {
  return DECISIONS[event];
}

/**
 * Whether the picture should be put back up. It should not, however loudly the
 * page says `play`, if an ad is what is playing or if the audio side is not
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
