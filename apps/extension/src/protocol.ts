import type { PlayMode } from './audio/mix-gain.ts';
import type { PrepareProgress } from './audio/progress.ts';
import type { Status } from './audio/status.ts';
import { DEFAULT_SETTINGS, type OnReady } from './settings.ts';

/**
 * What the four scopes of this extension say to each other.
 *
 * There are four, not two: the service worker owns the tab, the popup owns the
 * user gesture, the offscreen document owns the audio, and the content script
 * owns the page. `chrome.runtime.sendMessage` broadcasts to all of them at
 * once, so every message is wrapped in an envelope that names who it is for
 * and which tab it belongs to. The service worker is the only one that routes.
 *
 * Commands travel towards the audio, reports travel back, and requests go to
 * the service worker for the two things only it can do. Nothing in here
 * carries audio: the stems never leave the offscreen document.
 */

export type { PlayMode } from './audio/mix-gain.ts';
export type { PrepareProgress, PrepareStage } from './audio/progress.ts';
export type { Status } from './audio/status.ts';
export type { OnReady } from './settings.ts';

export type Side = 'background' | 'offscreen' | 'tab';

/**
 * Why a reset was asked for. All of them mean the buffer is worthless, which
 * is the point of the list: a pause is not on it.
 *
 * A separated block belongs to the timeline it was captured on. Jumping
 * somewhere else in the video, changing the rate, reaching the end, crossing
 * an ad boundary or loading another video all put the person on a different
 * timeline, and everything in flight was captured on the old one. Pausing does
 * none of that — the audio either side of a pause is the same song with
 * nothing missing between it — so pausing holds instead.
 */
export type ResetReason = 'seek' | 'ratechange' | 'navigation' | 'ended' | 'ad';

export type Command =
  | { readonly type: 'start'; readonly streamId: string; readonly tabId: number }
  | { readonly type: 'stop' }
  | { readonly type: 'reset'; readonly reason: ResetReason }
  /** The page paused: freeze the output where it is and keep everything. */
  | { readonly type: 'hold' }
  /** And carry on from the same sample, with the same delay. */
  | { readonly type: 'resume' }
  | { readonly type: 'mode'; readonly mode: PlayMode }
  | { readonly type: 'guide'; readonly level: number }
  /**
   * Whether to play the tab's own audio, undelayed, while priming. The
   * `continue` setting turns it on for every prime; an ad turns it on for the
   * ad's duration, because capture has muted the tab and the ad would
   * otherwise be silent.
   */
  | { readonly type: 'passthrough'; readonly enabled: boolean }
  /** What to do at the moment the delayed audio is ready. */
  | { readonly type: 'on-ready'; readonly onReady: OnReady };

/**
 * Every command's name, as a record rather than a list so that adding one to
 * the union above and forgetting it here fails the build.
 */
const COMMANDS: Readonly<Record<Command['type'], true>> = {
  start: true,
  stop: true,
  reset: true,
  hold: true,
  resume: true,
  mode: true,
  guide: true,
  passthrough: true,
  'on-ready': true,
};

/** Whether a body is for the audio side, which is the only side that acts. */
export function isCommand(body: Body): body is Command {
  return Object.hasOwn(COMMANDS, body.type);
}

/**
 * What the page and the popup ask of the service worker, which owns the tab.
 *
 * Starting carries a stream id when whoever asked was able to get one.
 * `chrome.tabCapture.getMediaStreamId` is granted off the back of a gesture in
 * an extension context, which a click in the popup is and a click inside the
 * page is not, so the popup fetches the id itself and passes it on. A page
 * that asks without one has the service worker try on its behalf, which it
 * will almost always be refused; then the panel is told to point at the
 * toolbar. Trying rather than assuming means the panel's own button starts
 * working by itself on the day Chrome allows it.
 */
export type Request =
  | {
      readonly type: 'request-start';
      /** From the popup's own gesture, or null when the page asked. */
      readonly streamId: string | null;
      /** The tab to capture, or null to mean the one that sent this. */
      readonly tabId: number | null;
    }
  | { readonly type: 'request-stop' };

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
  /** Seconds the output has spent frozen by a pause since the last reset. */
  readonly heldSeconds: number;
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
  heldSeconds: 0,
  driftMs: 0,
};

export interface StatusReport {
  readonly type: 'status';
  readonly status: Status;
  readonly reason: string | null;
  /**
   * How far along getting ready is, or null when it is not. There is no
   * countdown here on purpose: `audio/progress.ts` says why.
   */
  readonly prepare: PrepareProgress | null;
  /**
   * Why it is preparing again, when this is not the first time. The panel says
   * so, because a bar that starts over with no explanation reads as a crash.
   */
  readonly reprime: ResetReason | null;
  readonly delaySeconds: number | null;
  /**
   * Seconds the output has been frozen by pauses since the last reset. The
   * picture is behind the page by `delaySeconds + heldSeconds`, and this is
   * the second and last number that has to cross between the two halves.
   */
  readonly heldSeconds: number;
  readonly mode: PlayMode;
  readonly guide: number;
  readonly onReady: OnReady;
}

export interface MetricsReport {
  readonly type: 'metrics';
  readonly metrics: Metrics;
}

/**
 * Something only the person can do. There is one of these, and it exists
 * because of where Chrome puts the user gesture for a tab capture.
 */
export interface HintReport {
  readonly type: 'hint';
  readonly hint: 'toolbar';
}

export type Report = StatusReport | MetricsReport | HintReport;

export type Body = Command | Report | Request;

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

/**
 * Where the last status report is left in `chrome.storage.session`, for a
 * popup that has just been opened.
 *
 * A popup is a page that did not exist a moment ago and will not exist in a
 * moment's time, so it cannot have been listening when the report went past.
 * The service worker keeps the last one here as it routes it, and the popup
 * reads it on open and then follows `chrome.storage.onChanged` — which is a
 * push, so the bar moves without the popup asking anybody anything.
 */
export const STATUS_KEY = 'kara.status';

export interface StoredStatus {
  readonly tabId: number | null;
  readonly report: StatusReport;
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

/** The status with nothing running, which is what a stopped tab is told. */
export const IDLE_REPORT: StatusReport = {
  type: 'status',
  status: 'idle',
  reason: null,
  prepare: null,
  reprime: null,
  delaySeconds: null,
  heldSeconds: 0,
  mode: 'instrumental',
  guide: 0,
  onReady: DEFAULT_SETTINGS.onReady,
};

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
