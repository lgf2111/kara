/**
 * The one clock the picture and the audio can both read.
 *
 * The audio side times everything on the `AudioContext`, which is the right
 * clock for it and no use at all here: the context lives in the offscreen
 * document and the frames are captured in a content script, which are
 * different JavaScript realms in different processes with no shared object
 * between them. `performance.now()` is no better on its own, because each
 * context measures it from its own `timeOrigin` — the instant that context was
 * created — so two contexts reading it at the same moment get different
 * numbers.
 *
 * `timeOrigin + now()` is the same instant in both: milliseconds since the
 * Unix epoch, with a monotonic clock underneath rather than a wall clock that
 * can be stepped by NTP mid-song. So that is what a frame is stamped with.
 *
 * What the two sides agree on is one sentence, and `delaySeconds` in the
 * status report is the only number that has to cross between them: **a moment
 * of the tab captured at instant T is heard at T + delay.** The audio makes
 * that true on the context clock — the capture worklet stamps a chunk, the
 * player plays it `delay` later — and the picture makes it true on this clock,
 * by painting the frame that was displayed `delay` ago. Neither side has to
 * know the other's epoch.
 *
 * It is not exact to the millisecond, and nothing here pretends otherwise.
 * Capture adds a little latency before a sample reaches the worklet, and
 * `AudioContext.outputLatency` adds a little after the player writes one, so
 * the sound a person hears is some tens of milliseconds later than the picture
 * drawn for the same instant. That is within a frame or two at 15 fps, it does
 * not accumulate, and the harness measures what it comes to rather than
 * assuming it: `__karaDebug.pictureOffsetSeconds()`.
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
