import { KEY_DEFAULT } from './audio/key.ts';
import type { MediaSample } from './audio/media-time.ts';
import type { PlayMode } from './audio/mix-gain.ts';
import type { PrepareProgress } from './audio/progress.ts';
import type { Status } from './audio/status.ts';
import { IDLE_DUET, type DuetMix, type DuetStatus } from './audio/duet.ts';
import { DEFAULT_MIX, type StemMix } from './audio/stems.ts';
import type { PracticeAnalysis, PracticeLive } from './audio/practice.ts';
import type { SongAnalysis } from './audio/song-analysis.ts';
import type { Backend } from '../../web/src/separation/protocol.ts';
import type { StreamInfo } from './stream/player.ts';

/**
 * What the four scopes of this extension say to each other.
 *
 * There are four, not two: the service worker owns the tab, the popup owns the
 * person's click, the offscreen document owns the audio, and the content
 * script owns the page. `chrome.runtime.sendMessage` broadcasts to all of them
 * at once, so every message is wrapped in an envelope that names who it is
 * for and which tab it belongs to. The service worker is the only one that
 * routes.
 *
 * Commands travel towards the audio, reports travel back, and requests go to
 * the service worker for the two things only it can do. Nothing in here
 * carries audio: the stems never leave the offscreen document.
 */

export type { MediaSample } from './audio/media-time.ts';
export type { PlayMode } from './audio/mix-gain.ts';
export type { PrepareProgress, PrepareStage } from './audio/progress.ts';
export type { Status } from './audio/status.ts';
export type { DuetMix, DuetPhase, DuetProgress, DuetState, DuetStatus } from './audio/duet.ts';
export type {
  PracticeAnalysis,
  PracticeAnalysisState,
  PracticeLive,
  PracticeLiveTarget,
  PracticeMicReading,
  PracticeNote,
  PracticeScore,
} from './audio/practice.ts';
export type {
  SongAnalysis,
  SongAnalysisState,
  SongFacts,
  SongKey,
  SongRange,
} from './audio/song-analysis.ts';

export type Side = 'background' | 'offscreen' | 'tab';

/**
 * The audio stream of the video being watched, as the page reported it.
 *
 * The shape is owned by `src/stream/player.ts`, which the MAIN world script
 * and this file both import; the page can say anything in one of these, so
 * every receiver checks the fields it reads.
 */
export type { StreamInfo };

export type Command =
  /**
   * Read the stream, separate it, and hold the stems for the toggle. The
   * stream is what the page reported for the tab being started.
   */
  | {
      readonly type: 'start';
      readonly stream: StreamInfo;
      readonly tabId: number;
      /** The remembered default key. The offscreen document cannot read storage. */
      readonly key?: number;
    }
  | { readonly type: 'stop' }
  /** The vocal switch: the video's own sound, or the stems in its place. */
  | { readonly type: 'mode'; readonly mode: PlayMode }
  /**
   * The four slider positions and their mute and solo switches. The whole mix
   * travels rather than a patch, so a status report can never disagree with
   * what the player is doing.
   */
  | { readonly type: 'mix'; readonly mix: StemMix }
  /**
   * The opt-in second pass: split the vocal stem into Voice 1 and Voice 2.
   * The normal mixer stays usable while this runs.
   */
  | { readonly type: 'duet-start' }
  /** The two voice levels, in Voice 1 / Voice 2 order. */
  | { readonly type: 'duet-mix'; readonly mix: DuetMix }
  /** Exchange which separated stream is called Voice 1. */
  | { readonly type: 'duet-swap' }
  /**
   * Teach the helper that a moment in the song is one singer. The engine
   * sends a three-second window around `seconds`; the helper re-renders.
   */
  | { readonly type: 'duet-anchor'; readonly voice: 1 | 2; readonly seconds: number }
  /** Put the single vocal row back and forget the pair. */
  | { readonly type: 'duet-clear' }
  /**
   * Start pitch practice: learn the guide melody from the separated vocal
   * stem, then open the microphone and score against the video's clock. This
   * is opt-in and never changes the stems the normal mixer is playing.
   */
  | { readonly type: 'practice-start' }
  /** Release the microphone, stop analysing and put the video back. */
  | { readonly type: 'practice-stop' }
  /**
   * The key, in semitones. It belongs to the session rather than to the
   * video, so a seek, a pause or an ad leaves it exactly where the person put
   * it; only another one of these moves it.
   */
  | { readonly type: 'key'; readonly semitones: number }
  /**
   * Where the page is in the song, about four times a second and on every
   * media event. The stems are anchored to these, which is how a seek, a
   * pause and an ad all reach the audio without commands of their own.
   */
  | { readonly type: 'media'; readonly sample: MediaSample }
  /** Send the debug state back, for the popup's copy button. */
  | { readonly type: 'debug' };

/**
 * Every command's name, as a record rather than a list so that adding one to
 * the union above and forgetting it here fails the build.
 */
const COMMANDS: Readonly<Record<Command['type'], true>> = {
  start: true,
  stop: true,
  mode: true,
  mix: true,
  'duet-start': true,
  'duet-mix': true,
  'duet-swap': true,
  'duet-anchor': true,
  'duet-clear': true,
  'practice-start': true,
  'practice-stop': true,
  key: true,
  media: true,
  debug: true,
};

/** Whether a body is for the audio side, which is the only side that acts. */
export function isCommand(body: Body): body is Command {
  return Object.hasOwn(COMMANDS, body.type);
}

/**
 * What the page and the popup ask of the service worker, which owns the tab.
 *
 * Starting carries no permission and no gesture any more: the audio is read
 * from the stream the page itself reported, so a click anywhere — the popup
 * or the panel in the page — can start it. The service worker refuses, with
 * words, when the page has not reported a stream for that tab yet.
 */
export type Request =
  | {
      readonly type: 'request-start';
      /** The tab to start, or null to mean the one that sent this. */
      readonly tabId: number | null;
    }
  | { readonly type: 'request-stop' }
  /** The page found the audio stream of the video it is watching. */
  | { readonly type: 'request-stream'; readonly stream: StreamInfo };

export interface Metrics {
  /** Where the stems are playing in the song, or null before they are. */
  readonly mediaSeconds: number | null;
  /** The frame the player is reading, or -1 while it is playing nothing. */
  readonly playFrame: number;
  /** Frames of stem the player holds. */
  readonly stemFrames: number;
  /** Windows separated, and the whole number of them. */
  readonly windowsDone: number;
  readonly windowsTotal: number;
  /** Median milliseconds one window costs to separate. */
  readonly computeMs: number | null;
  /** Where the download has got to, for the report. */
  readonly downloadBytes: number;
  readonly downloadTotal: number | null;
}

export const NO_METRICS: Metrics = {
  mediaSeconds: null,
  playFrame: -1,
  stemFrames: 0,
  windowsDone: 0,
  windowsTotal: 0,
  computeMs: null,
  downloadBytes: 0,
  downloadTotal: null,
};

export interface StatusReport {
  readonly type: 'status';
  readonly status: Status;
  readonly reason: string | null;
  /**
   * How far along preparing is, or null when it is not. There is no
   * countdown here on purpose: `audio/progress.ts` says why.
   */
  readonly prepare: PrepareProgress | null;
  /**
   * Whether the separated stems reach the point the video is at. They become
   * usable before the whole track is done — as soon as the frontier passes
   * the playhead — which is what lets the vocal switch come alive early.
   */
  readonly covered: boolean;
  /** Which sound is playing: the video's own, or the stems. */
  readonly mode: PlayMode;
  /** Slider positions and mute/solo switches for all four stems. */
  readonly mix: StemMix;
  /** The opt-in Voice 1 / Voice 2 pair, or off before anyone asks. */
  readonly duet?: DuetStatus;
  /** The key the stems are played in, in whole semitones. */
  readonly semitones: number;
  /**
   * How many seconds from the start have their stems ready. Separation runs
   * from the beginning outwards, so this is a prefix rather than a list of
   * ranges; the page draws it on the progress bar. Null before any block.
   */
  readonly analyzedSeconds: number | null;
  /** Which video the stems belong to, or null with nothing prepared. */
  readonly videoId: string | null;
  /** The song's length, in seconds, or null with nothing prepared. */
  readonly durationSeconds: number | null;
}

export interface MetricsReport {
  readonly type: 'metrics';
  readonly metrics: Metrics;
}

/** What the offscreen document knows, for the popup's copy button. */
export interface PipelineDebug {
  readonly atMs: number;
  readonly status: Status;
  readonly reason: string | null;
  readonly sampleRate: number;
  readonly metrics: Metrics;
  readonly videoId: string | null;
  readonly durationSeconds: number | null;
  /** Which backend separated the track, once the model has loaded. */
  readonly backend: Backend | null;
  /** Why that backend was chosen, in the policy's own words. */
  readonly backendReason: string | null;
}

export interface DebugReportMessage {
  readonly type: 'debug-log';
  readonly pipeline: PipelineDebug;
}

/**
 * How the guide melody is getting on. Sent once when analysis starts, as it
 * progresses, and once when it is ready or has failed. The note list travels
 * with the ready report and not before, so a page never draws a half-melody.
 */
export type PracticeAnalysisReport = PracticeAnalysis & {
  readonly type: 'practice-analysis';
};

/**
 * The live practice view, about seventeen times a second while the microphone
 * is open. It carries measurements rather than audio: a pitch, a level and a
 * score. Both sides are normalised on receipt, because a report is an
 * untrusted shape like any other.
 */
export type PracticeLiveReport = PracticeLive & {
  readonly type: 'practice-live';
};

/**
 * The key, tempo and vocal range of the separated song. It arrives once when
 * the analysis starts, as it progresses, and once when it is ready or has
 * failed. The facts travel only with the ready report, so a page never draws a
 * half-read key; the video id lets a late report for the previous song be
 * ignored rather than shown over the next one.
 */
export type SongAnalysisReport = SongAnalysis & {
  readonly type: 'song-analysis';
  readonly videoId: string;
};

export type Report =
  | StatusReport
  | MetricsReport
  | DebugReportMessage
  | PracticeAnalysisReport
  | PracticeLiveReport
  | SongAnalysisReport;

export type Body = Command | Report | Request;

/** Tags a message as ours, so another extension's chatter is ignored. */
const TAG = 'kara/1';

export interface Packet {
  readonly kara: typeof TAG;
  readonly to: Side;
  /** The tab it belongs to, or null for a message that belongs to no tab. */
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

/** And where the last debug state is left, for the same reason. */
export const DEBUG_KEY = 'kara.debug';

export interface StoredStatus {
  readonly tabId: number | null;
  readonly report: StatusReport;
}

export interface StoredDebug {
  readonly tabId: number | null;
  readonly pipeline: PipelineDebug;
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
  covered: false,
  mode: 'original',
  mix: DEFAULT_MIX,
  duet: IDLE_DUET,
  semitones: KEY_DEFAULT,
  analyzedSeconds: null,
  videoId: null,
  durationSeconds: null,
};
