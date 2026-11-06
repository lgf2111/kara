/**
 * Where the page is in the song, as the page itself reports it.
 *
 * The content script reads `video.currentTime` about four times a second and
 * on every media event, and sends one of these to the offscreen document.
 * It is the clock both halves follow: the stems are anchored to it, so a
 * seek, a pause or an ad moves the audio by moving the anchor, and nothing
 * can drift because there is nothing free-running — every report re-aims the
 * player at where the video actually is.
 *
 * A report is a measurement of the past, so an instant past it has to be
 * projected from it: at most a sampling interval's worth, a quarter of a
 * second. {@link projectMediaSeconds} is that projection, which is what the
 * player is aimed with.
 *
 * Pure, so the projection is the test.
 */

/** Where the page was at one instant, as the page itself reported it. */
export interface MediaSample {
  /** `performance.timeOrigin + performance.now()`, which both halves share. */
  readonly wallMs: number;
  /** `video.currentTime`. */
  readonly mediaSeconds: number;
  /** Whether the page claimed to be moving through the song. */
  readonly playing: boolean;
  /** `video.playbackRate`, which the stems follow within `audio/tempo.ts`. */
  readonly rate: number;
  /** Whether an ad is on screen, which sends the stems away for its length. */
  readonly inAd: boolean;
}

function sane(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Where the page is right now, projected from a report read moments ago.
 *
 * The projection is the one number the player is aimed with: it arrives a
 * few milliseconds after the report was taken, and those milliseconds moved
 * the video.
 */
export function projectMediaSeconds(sample: MediaSample, nowWallMs: number): number {
  const elapsed = Math.max(0, sane(nowWallMs, sample.wallMs) - sample.wallMs) / 1000;
  const moved = sample.playing ? elapsed * sane(sample.rate, 1) : 0;
  return Math.max(0, sane(sample.mediaSeconds, 0) + moved);
}

/** A report with every field something arithmetic can be done on. */
export function tidySample(sample: MediaSample): MediaSample {
  return {
    wallMs: sane(sample.wallMs, 0),
    mediaSeconds: Math.max(0, sane(sample.mediaSeconds, 0)),
    playing: sample.playing,
    rate: Math.max(0, sane(sample.rate, 1)),
    inAd: sample.inAd === true,
  };
}

/**
 * Where the player's read head belongs when the video is at `mediaSeconds`.
 *
 * The pitch shifter after the player holds each sample for `latencySamples`.
 * The player is therefore feeding the future: at the instant the shifter
 * outputs the sample the video is showing, the player must already have read
 * `latencySamples` of *output* time ahead. At a rate other than one, that much
 * output time is `rate` times as much source time, so the read-ahead is scaled
 * with the rate. Reading at 2× with an unscaled lead would leave the stems a
 * shifter's worth of the song behind the picture.
 */
export function anchorHeadFrame(
  mediaSeconds: number,
  rate: number,
  latencySamples: number,
  sampleRate: number,
): number {
  const media = Math.max(0, sane(mediaSeconds, 0));
  const tempo = rate > 0 ? sane(rate, 1) : 1;
  const latency = Math.max(0, sane(latencySamples, 0));
  return media * sane(sampleRate, 0) + tempo * latency;
}

/**
 * The media frame a read head implies, which is what the player reports as
 * its playhead. The inverse of {@link anchorHeadFrame} without the rate's
 * source time: subtract the same scaled read-ahead.
 */
export function headMediaFrame(
  headFrame: number,
  rate: number,
  latencySamples: number,
): number {
  const tempo = rate > 0 ? sane(rate, 1) : 1;
  return sane(headFrame, 0) - tempo * Math.max(0, sane(latencySamples, 0));
}
