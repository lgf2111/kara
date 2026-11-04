import type { DelayChange } from './audio/delay-plan.ts';
import type { LoggedEvent } from './audio/event-log.ts';
import type { Metrics, Status, StatusReport } from './protocol.ts';

/**
 * What a person can copy when this goes wrong, and what they cannot.
 *
 * Everything interesting about a live separation happens once, four minutes
 * into a song, on a machine nobody else has. The useful facts are the ones
 * that are gone by the time anybody looks: which reset fired and why, how long
 * the page spent buffering, when the output first fell behind, what a window
 * cost by then. So the offscreen document keeps them in a ring
 * (`audio/event-log.ts`), the service worker relays them, and the popup has a
 * button that puts the lot on the clipboard as JSON.
 *
 * The rest of this file is about what that JSON must not contain, which is
 * more important than what it does.
 *
 * - **No media.** Not a sample, not a frame, not a loudness curve anybody
 *   could reconstruct one from. The stems never leave the offscreen document
 *   and nothing here is a channel of audio.
 * - **No address beyond the origin.** `https://www.youtube.com` and not the
 *   watch id, the playlist, the timestamp or the query. A video id is a
 *   statement about what somebody was listening to, and this file exists to
 *   help with a stall rather than to record that.
 * - **No title.** The page's title is the name of the song, which is the same
 *   statement by another route.
 *
 * {@link safeOrigin} is the one place that redaction happens, so there is one
 * place to read before trusting it, and a test asserts that a watch URL comes
 * out as an origin and nothing else.
 */

/** Where the page was, reduced to the only part worth keeping. */
export function safeOrigin(url: string | undefined): string {
  if (url === undefined) {
    return '';
  }
  try {
    const parsed = new URL(url);
    // `origin` is scheme, host and port. Everything that names a video — the
    // path, the query, the fragment — is dropped here and nowhere else.
    return parsed.origin === 'null' ? '' : parsed.origin;
  } catch {
    return '';
  }
}

/** Where the capture and the song have got to, in numbers. */
export interface MediaDebug {
  /** Bends in the sample-to-song mapping, which is one per discarded stretch. */
  readonly anchors: number;
  readonly keptSeconds: number;
  /** Capture thrown away because the song was not moving. */
  readonly droppedSeconds: number;
  /** Real discontinuities seen: seeks, judged on media time. */
  readonly jumps: number;
  /** Where the output is in the song, or null before it is playing. */
  readonly positionSeconds: number | null;
  /** What the page last said about itself. */
  readonly playing: boolean | null;
  readonly rate: number | null;
}

/** What the offscreen document knows, which is most of it. */
export interface PipelineDebug {
  readonly atMs: number;
  readonly status: Status;
  readonly reason: string | null;
  readonly sampleRate: number;
  readonly delaySeconds: number | null;
  /** Every delay it has settled on, and why. */
  readonly delays: readonly DelayChange[];
  readonly metrics: Metrics;
  readonly media: MediaDebug;
  readonly events: readonly LoggedEvent[];
  /** Events the ring has had to forget. */
  readonly droppedEvents: number;
}

export interface DebugReportInput {
  readonly atMs: number;
  /** The tab's address, which is redacted to its origin on the way in. */
  readonly url: string | undefined;
  readonly status: StatusReport | null;
  /** Null when nothing is running, which is itself worth reporting. */
  readonly pipeline: PipelineDebug | null;
  readonly version: string;
}

export interface DebugReport {
  readonly kara: 'debug/1';
  readonly atMs: number;
  readonly version: string;
  /** Scheme and host only. Never a path, a query or a video id. */
  readonly origin: string;
  readonly userAgent: string;
  readonly status: {
    readonly status: Status | 'none';
    readonly reason: string | null;
    readonly delaySeconds: number | null;
    readonly semitones: number;
    readonly mode: string;
    readonly onReady: string;
    readonly stage: string | null;
    readonly fraction: number | null;
  };
  readonly pipeline: PipelineDebug | null;
}

export function debugReport(input: DebugReportInput, userAgent = ''): DebugReport {
  const status = input.status;
  return {
    kara: 'debug/1',
    atMs: input.atMs,
    version: input.version,
    origin: safeOrigin(input.url),
    userAgent,
    status: {
      status: status?.status ?? 'none',
      reason: status?.reason ?? null,
      delaySeconds: status?.delaySeconds ?? null,
      semitones: status?.semitones ?? 0,
      mode: status?.mode ?? 'instrumental',
      onReady: status?.onReady ?? 'restart',
      stage: status?.prepare?.stage ?? null,
      fraction: status?.prepare?.fraction ?? null,
    },
    pipeline: input.pipeline,
  };
}

/** The text that goes on the clipboard. Indented, because it gets pasted. */
export function debugReportText(input: DebugReportInput, userAgent = ''): string {
  return `${JSON.stringify(debugReport(input, userAgent), null, 2)}\n`;
}
