/**
 * The one clock the page and the audio can both read.
 *
 * The audio side times everything on the `AudioContext`, which is the right
 * clock for it and no use at all to the page: the context lives in the
 * offscreen document and the video lives in the page, which are different
 * realms in different processes with no shared object between them.
 * `performance.now()` is no better on its own, because each context measures
 * it from its own `timeOrigin` — the instant that context was created — so
 * two contexts reading it at the same moment get different numbers.
 *
 * `timeOrigin + now()` is the same instant in both: milliseconds since the
 * Unix epoch, with a monotonic clock underneath rather than a wall clock that
 * can be stepped by NTP mid-song. So that is what a media sample is stamped
 * with, and what the player is aimed with: the page reports where the video
 * was at wall instant W, and the audio projects that forward to the instant
 * the report arrives. There is no delay to account for between the two
 * sides — the video is heard as itself, and the stems play exactly where the
 * report says the video is.
 *
 * It is not exact to the millisecond, and nothing here pretends otherwise.
 * A report is a few milliseconds old when it arrives, and
 * `AudioContext.outputLatency` adds a few more after the player writes a
 * sample, so the sound a person hears is some tens of milliseconds later than
 * the picture drawn for the same instant. That is within a frame or two at
 * 15 fps, and it does not accumulate.
 */

/** Now, on the clock both contexts share. Milliseconds. */
export function wallNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * A `DOMHighResTimeStamp` from this context — `requestVideoFrameCallback`'s
 * `expectedDisplayTime`, say — moved onto the shared clock.
 */
export function wallMsOf(timestamp: number): number {
  return performance.timeOrigin + timestamp;
}
