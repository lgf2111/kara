import { packet, packetFor, type Report, type ResetReason } from './protocol.ts';

/**
 * The page's side of it. Step A's half of a file step B will finish.
 *
 * Audio needs two things from the page, and both are here. It needs to be told
 * when the audio it has buffered stopped being worth anything: a seek, a
 * pause, a resume or a rate change all mean the next sixteen seconds of
 * separated audio belong to a timeline nobody is on any more, so each one
 * sends a reset and the pipeline primes again. And it needs somewhere for
 * reports to land, which is the isolated world's `__karaReport`.
 *
 * What is not here is the picture. Step B delays the video by the same amount
 * the audio is delayed by, which is `delaySeconds` in the status reports this
 * already receives, and leaves the page's own audio alone because tab capture
 * has already muted it. Nothing in that touches this file's reset handling, so
 * the two halves do not have to be written at once.
 *
 * Media events do not bubble, so the listeners are on the document in the
 * capture phase: that catches them wherever they are targeted, which matters
 * on a site that replaces its video element whenever it feels like it.
 */

const RESETS: readonly { readonly event: string; readonly reason: ResetReason }[] = [
  { event: 'seeking', reason: 'seek' },
  { event: 'pause', reason: 'pause' },
  { event: 'play', reason: 'play' },
  { event: 'ratechange', reason: 'ratechange' },
];

/**
 * Where the last report from the audio side is kept: the content script's own
 * isolated world, which the page cannot see and the extension's devtools
 * console can. Step B reads `delaySeconds` from the status report here.
 */
interface ReportHolder {
  __karaReport?: Report;
}

function ask(reason: ResetReason): void {
  // Straight to the offscreen document: a runtime message from a content
  // script reaches every extension context, and the envelope says which one
  // should act on it.
  chrome.runtime.sendMessage(packet('offscreen', { type: 'reset', reason })).catch(() => undefined);
}

for (const { event, reason } of RESETS) {
  document.addEventListener(
    event,
    (fired) => {
      if (fired.target instanceof HTMLMediaElement) {
        ask(reason);
      }
    },
    true,
  );
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const received = packetFor('tab', message);
  const body = received?.body;
  if (body !== undefined && (body.type === 'status' || body.type === 'metrics')) {
    (globalThis as unknown as ReportHolder).__karaReport = body;
  }
  return false;
});
