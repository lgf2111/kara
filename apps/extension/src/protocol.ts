import type { PlayMode } from './audio/mix-gain.ts';
import type { Status } from './audio/status.ts';

/**
 * What the three halves of this extension say to each other.
 *
 * There are three, not two: the service worker owns the user gesture and the
 * tab, the offscreen document owns the audio, and the content script owns the
 * page. `chrome.runtime.sendMessage` broadcasts to all of them at once, so
 * every message is wrapped in an envelope that names who it is for and which
 * tab it belongs to. The service worker is the only one that routes.
 *
 * Commands travel towards the audio, reports travel back. Nothing in here
 * carries audio: the stems never leave the offscreen document.
 */

export type { PlayMode } from './audio/mix-gain.ts';
export type { Status } from './audio/status.ts';

export type Side = 'background' | 'offscreen' | 'tab';

/** Why a reset was asked for. All of them mean the buffer is worthless. */
export type ResetReason = 'seek' | 'pause' | 'play' | 'ratechange' | 'navigation';

export type Command =
  | { readonly type: 'start'; readonly streamId: string; readonly tabId: number }
  | { readonly type: 'stop' }
  | { readonly type: 'reset'; readonly reason: ResetReason }
  | { readonly type: 'mode'; readonly mode: PlayMode }
  | { readonly type: 'guide'; readonly level: number }
  /**
   * Whether to play the tab's own audio, undelayed, while priming. Off by
   * default: sixteen seconds of undelayed audio followed by a jump to the
   * delayed stream is worse than sixteen seconds of quiet.
   */
  | { readonly type: 'passthrough'; readonly enabled: boolean };

export interface Metrics {
  /** The delay the player settled on, or null while priming. */
  readonly delaySeconds: number | null;
  /** How late the last block actually was, measured on the capture clock. */
  readonly measuredLagMs: number | null;
  /** How late the separator said it would be. */
  readonly reportedLagMs: number | null;
  /** Median milliseconds one window costs to separate. */
  readonly computeMs: number | null;
  /** Captured samples no finalised block covers yet. */
  readonly bufferSamples: number;
  readonly blocks: number;
  readonly underrunFrames: number;
  readonly lateFrames: number;
  readonly gapFrames: number;
  readonly queuedFrames: number;
  /** Where the capture stamps have drifted from the sample count. */
  readonly driftMs: number;
}

export const NO_METRICS: Metrics = {
  delaySeconds: null,
  measuredLagMs: null,
  reportedLagMs: null,
  computeMs: null,
  bufferSamples: 0,
  blocks: 0,
  underrunFrames: 0,
  lateFrames: 0,
  gapFrames: 0,
  queuedFrames: 0,
  driftMs: 0,
};

export interface StatusReport {
  readonly type: 'status';
  readonly status: Status;
  readonly reason: string | null;
  /** Seconds of priming left, or null when not priming. */
  readonly secondsLeft: number | null;
  readonly delaySeconds: number | null;
  readonly mode: PlayMode;
  readonly guide: number;
}

export interface MetricsReport {
  readonly type: 'metrics';
  readonly metrics: Metrics;
}

export type Report = StatusReport | MetricsReport;

export type Body = Command | Report;

/** Tags a message as ours, so another extension's chatter is ignored. */
const TAG = 'kara/1';

export interface Packet {
  readonly kara: typeof TAG;
  readonly to: Side;
  /** The captured tab, or null for a message that belongs to no tab. */
  readonly tabId: number | null;
  readonly body: Body;
}

export function packet(to: Side, body: Body, tabId: number | null = null): Packet {
  return { kara: TAG, to, tabId, body };
}

/** A received message, if it is ours and addressed to this side. */
export function packetFor(to: Side, value: unknown): Packet | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Partial<Packet>;
  if (candidate.kara !== TAG || candidate.to !== to) {
    return null;
  }
  return candidate as Packet;
}

/** What one separated block came to, for the debug harness and the metrics. */
export interface BlockStat {
  readonly startSample: number;
  readonly frames: number;
  /** Context time the block's first sample was captured at. */
  readonly captureTime: number;
  /** Context time it is due to be heard. */
  readonly playTime: number;
  /** Context time it came back from the separator. */
  readonly arrivedAt: number;
  /** Root mean square of a sparse sample of each pair, to prove it has audio. */
  readonly vocalsRms: number;
  readonly instrumentalRms: number;
}
