import { DEFAULT_MIX, normaliseMix, type StemMix } from './audio/stems.ts';
import type { PipelineDebug, Status, StatusReport } from './protocol.ts';

/**
 * What a person can copy when this goes wrong, and what they cannot.
 *
 * The useful facts are the ones that are gone by the time anybody looks:
 * which stage it died in, how many windows had run, what a window cost. So
 * the offscreen document sends its state over, the service worker relays it,
 * and the popup has a button that puts the lot on the clipboard as JSON.
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
  readonly kara: 'debug/3';
  readonly atMs: number;
  readonly version: string;
  /** Scheme and host only. Never a path, a query or a video id. */
  readonly origin: string;
  readonly userAgent: string;
  readonly status: {
    readonly status: Status | 'none';
    readonly reason: string | null;
    readonly semitones: number;
    /** Slider levels and mute/solo switches, so a buzz can be attributed to one stem. */
    readonly mix: StemMix;
    readonly mode: string;
    readonly stage: string | null;
    readonly fraction: number | null;
    /** The song's length in seconds, which names no song. */
    readonly durationSeconds: number | null;
  };
  readonly pipeline: PipelineDebug | null;
}

export function debugReport(input: DebugReportInput, userAgent = ''): DebugReport {
  const status = input.status;
  return {
    kara: 'debug/3',
    atMs: input.atMs,
    version: input.version,
    origin: safeOrigin(input.url),
    userAgent,
    status: {
      status: status?.status ?? 'none',
      reason: status?.reason ?? null,
      semitones: status?.semitones ?? 0,
      mix: normaliseMix(status?.mix ?? DEFAULT_MIX),
      mode: status?.mode ?? 'original',
      stage: status?.prepare?.stage ?? null,
      fraction: status?.prepare?.fraction ?? null,
      durationSeconds: status?.durationSeconds ?? null,
    },
    pipeline: input.pipeline,
  };
}

/** The text that goes on the clipboard. Indented, because it gets pasted. */
export function debugReportText(input: DebugReportInput, userAgent = ''): string {
  return `${JSON.stringify(debugReport(input, userAgent), null, 2)}\n`;
}
