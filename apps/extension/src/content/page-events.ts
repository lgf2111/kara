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
 * **A seek is the row that changed next, and it changed by leaving.** The
 * audio no longer resets because the page said `seeking`. It resets because
 * media time jumped, which the audio side sees for itself within a chunk of
 * capture — a jump is the only evidence of a seek that buffering, a quality
 * change and a new source cannot fake, and all three of those used to cost
 * the entire delay for nothing. What is left on the audio's reset list here is
 * what only the page can know: a rate change, the end, an ad boundary and
 * another video.
 *
 * The picture still comes down and goes back up on a seek, because the frames
 * it is holding are from somewhere else in the song, and `timeline.ts` is
 * still what judges whether a `seeking` event was a jump at all — by the same
 * arithmetic on the same clock the audio half uses.
 *
 * The picture half of each row is a choice, and worth being honest about. A
 * frame is stamped with where in the song it belongs, so strictly the picture
 * needs no resetting: it paints whatever frame matches the place the audio
 * says it has reached, and after a seek that would be the right frame of the
 * old stretch of song. What makes it wrong is that it would be eighteen
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
  // The audio rows here are deliberately empty. A `seeking` event is not
  // evidence of a seek — the page fires it for buffering, for a quality
  // change, for adopting a new source and at the start of playback — and the
  // audio side has better evidence than any event: whether media time jumped.
  // So the picture comes down and goes back up, because the frames it holds
  // are from elsewhere in the song, and the audio decides for itself.
  seeking: { audio: 'none', reset: null, picture: 'clear', passthrough: null },
  seeked: { audio: 'none', reset: null, picture: 'reprime', passthrough: null },
  // Nothing is thrown away and nothing is primed: see above.
  pause: { audio: 'hold', reset: null, picture: 'freeze', passthrough: null },
  play: { audio: 'resume', reset: null, picture: 'thaw', passthrough: null },
  // The frames survive a rate change — they are stamped with where in the
  // song they belong — but the audio's buffer does not, because every sample
  // after it arrives at a different rate than the ones before it, and a
  // picture running over eighteen seconds of silence looks broken.
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
