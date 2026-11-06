import type { PlayMode, Status } from '../protocol.ts';
import { canFollowTempo } from '../audio/tempo.ts';

/**
 * Whether the video's own sound should be muted right now.
 *
 * This is the page's half of the vocal switch. The offscreen document owns
 * the stems; this file owns the one decision the page can make better than
 * anybody: when the video's own audio must step aside for them. That is
 * exactly while the stems are playing — the mode is `instrumental`, the video
 * is actually moving, at a speed the stems can follow, no ad is on screen, and
 * the separated audio has reached the playhead.
 *
 * Everything else is the video's own sound:
 *
 * - `original` mode, which is the toggle in its resting position.
 * - a pause, which has no sound to mute and must not come back muted-flavoured.
 * - a speed outside the player's range, where the video's own pitch-preserved
 *   speed change is the honest thing to hear. Inside it the stems follow the
 *   page's rate and the key shifter cancels the transposition; the engine asks
 *   `canFollowTempo` the same question, so the two halves cannot disagree.
 * - an ad, which the extension deliberately does not process: the ad's own
 *   audio is the only honest thing to play through it.
 * - a seek ahead of the separated frontier, where there is nothing of ours to
 *   play yet. The stems take over when they get there.
 *
 * Called on every tick and every report, because the video element can be
 * replaced under the page at any moment and a mute is a property of the
 * element, not of the page. Pure, so the table is the test.
 */
export function shouldMuteVideo(options: {
  readonly mode: PlayMode;
  /** The session's status; an error or idle has nothing to mute for. */
  readonly status: Status | null;
  /**
   * Whether the stems have reached the point the video is at. While the rest
   * of the track is still being separated, this is true only once the
   * frontier has passed the playhead.
   */
  readonly covered: boolean;
  readonly playing: boolean;
  readonly inAd: boolean;
  readonly rate: number;
}): boolean {
  const status = options.status;
  if (status !== 'ready' && status !== 'paused' && status !== 'preparing') {
    return false;
  }
  return (
    options.mode === 'instrumental' &&
    options.covered &&
    options.playing &&
    !options.inAd &&
    canFollowTempo(options.rate)
  );
}
