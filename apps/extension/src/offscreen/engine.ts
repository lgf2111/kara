import {
  DOWNLOAD_CHUNK_BYTES,
  parseContentLength,
  parseContentRange,
} from '../audio/download.ts';
import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';

import { clampKey, KEY_DEFAULT, keyRoute } from '../audio/key.ts';
import { decodeStereo } from '../audio/decode.ts';
import { DuetClient } from '../audio/duet-client.ts';
import { projectMediaSeconds, tidySample, type MediaSample } from '../audio/media-time.ts';
import { canFollowTempo, pitchSemitonesForKey } from '../audio/tempo.ts';
import { FADE_SECONDS, type PlayMode } from '../audio/mix-gain.ts';
import {
  DEFAULT_DUET_CONFIG,
  IDLE_DUET,
  duetGains,
  duetPhaseLabel,
  normaliseDuetConfig,
  normaliseDuetMix,
  type DuetConfig,
  type DuetMix,
  type DuetStatus,
} from '../audio/duet.ts';
import { encodeWavMono } from '../audio/wav.ts';
import { IDLE_MIC_STATUS, type MicFx } from '../audio/mic-fx.ts';
import type { PracticeNote } from '../audio/practice.ts';
import { SONG_ANALYSIS_RATE } from '../audio/song-analysis.ts';
import { duetLowConfidenceOf, prepareCache, stemCache } from '../cache/index.ts';
import type { CachedStems } from '../cache/entry.ts';
import type { CacheStatus } from '../cache/status.ts';
import { MicRoom } from './mic-room.ts';
import { startPractice as startPracticeSession, type PracticeHandle } from './practice.ts';
import {
  StemCacheSession,
  type CacheStart,
  type StemCacheStore,
} from './stem-cache-session.ts';
import type {
  SongAnalysisCommand,
  SongAnalysisEvent,
} from './song-analysis-messages.ts';
import {
  advanceProgress,
  NO_TIMINGS,
  prepareProgress,
  type DownloadFacts,
  type Pieces,
  type PrepareProgress,
  type StageTimings,
} from '../audio/progress.ts';
import { IDLE, nextStatus, type StatusEvent, type StatusState } from '../audio/status.ts';
import { DEFAULT_MIX, mixGains, normaliseMix, STEMS, type StemMix } from '../audio/stems.ts';
import {
  STEM_PLAYER_PROCESSOR,
  type StemPlayerCommand,
  type StemPlayerReport,
} from '../audio/stem-player-messages.ts';
import { wallNowMs } from '../picture/wall-clock.ts';
import { reasonText } from '../reason.ts';
import type { SeparatorCommand, SeparatorEvent } from '../separation/messages.ts';
import { SAMPLE_RATE, SEPARATION_MODEL_VERSION } from '../separation/model.ts';
import type {
  Metrics,
  PipelineDebug,
  PracticeAnalysisReport,
  PracticeLiveReport,
  SongAnalysisReport,
  StatusReport,
  StreamInfo,
} from '../protocol.ts';
import { NO_METRICS, packet } from '../protocol.ts';
import { medianMs, planJob } from '../../../web/src/separation/job.ts';

/**
 * The whole session, in one place: read, separate, hold, follow.
 *
 * Four stages, in order.
 *
 * 1. **Read.** The stream the page reported is fetched and decoded. Nothing
 *    here asks the page for permission it has not already given: the stream
 *    is the one the page itself is playing, and the fetch leaves the device
 *    only in the sense that the page's own playback already did.
 * 2. **Separate.** The decoded track is pushed to the separation worker — the
 *    same engine the web app runs on an uploaded file — and the blocks that
 *    come back are written into eight stem buffers: drums, bass, other and
 *    vocals, two channels each. The whole track, so the toggle can point at
 *    any timestamp and play it, and so the mixer can change its mind at any
 *    timestamp without asking the model again.
 * 3. **Hold.** Each block is handed to the player worklet as it is finalised,
 *    and the worklet owns the track from then on. Nothing else needs it, and
 *    transferring is the only copy. Because the blocks arrive in order, the
 *    player can start on the first one: the vocal switch goes live as soon as
 *    the separated frontier has passed the playhead, while the rest of the
 *    track is still being separated.
 * 4. **Follow.** The content script reports where the video is, four times a
 *    second. Each report is projected to now and handed to the player as an
 *    anchor, so the stems follow the video wherever it goes — a seek, a
 *    pause, an ad, a rate change, all of them are just a report, and none of
 *    them needs a command of its own.
 *
 * What the person hears is decided by the mode, which is the one switch this
 * engine owns: `original` mutes the player and the video sounds as it always
 * did; `instrumental` mutes the video — the content script's half of the job —
 * and fades the player up. Both sides of the switch are the same song at the
 * same position, so the fade is a thirty millisecond ramp on one gain and
 * nothing more. Inside `instrumental` the mix is four levels and their mute
 * and solo switches; the engine resolves those to four gains, and moving a
 * slider or pressing M or S is also a thirty-millisecond ramp on those gains.
 */

/** The analyser transform: about 1.3 Hz a bin, only built when asked. */
const ANALYSER_FFT = 32768;

/** Below this much, the loudest bin is the noise floor rather than a note. */
const ANALYSER_FLOOR_DB = -90;

/** Seconds of track pushed per chunk. Small enough that one chunk's copy is
 * nothing, big enough that the worker's message queue is not the bottleneck. */
const CHUNK_SECONDS = 2;

/** The overlap the web app separates files with, which the plan is priced by. */
const OVERLAP = 0.25;

/** How far ahead the frontier must be before the stems take over. */
const COVER_START_LEAD_SECONDS = 1;

/** How close the frontier may get before they hand the sound back. */
const COVER_STOP_LEAD_SECONDS = 0.25;

/** How long the key path takes to fade out and back in when it changes. */
const ROUTE_FADE_SECONDS = 0.02;

/** Slack over the shifter's delay before its buffer holds the new head. */
const ROUTE_PRIME_MS = 30;

export interface EngineOptions {
  readonly stream: StreamInfo;
  readonly weightsBase: string;
  readonly runtimePath: string;
  readonly playbackWorkletUrl: string;
  /** The Signalsmith Stretch worklet module, which applies the key after the player. */
  readonly pitchWorkletUrl: string;
  readonly mode?: PlayMode;
  /** The starting mix. Defaults to karaoke: all sliders full, vocal muted. */
  readonly mix?: StemMix;
  readonly key?: number;
  /**
   * The duet helper URL and token, read by the service worker. The offscreen
   * document cannot read storage, so the connection arrives with the start.
   */
  readonly duet?: DuetConfig;
  /** Taps the output with an `AnalyserNode`, for the debug harness only. */
  readonly analyse?: boolean;
  /**
   * The stem cache. The extension's OPFS cache by default; a test passes a
   * fake so a hit needs no filesystem or WebCodecs.
   */
  readonly cache?: StemCacheStore;
  /** The maintenance pass before a lookup. Defaults to the real cache's. */
  readonly prepareCache?: () => Promise<void>;
  readonly onStatus: (report: StatusReport) => void;
  readonly onMetrics: (metrics: Metrics) => void;
  /** Practice analysis and live reports, when a person has opted in. */
  readonly onPractice?: (report: PracticeAnalysisReport | PracticeLiveReport) => void;
  /** The song's key, tempo and vocal range, once separation has finished. */
  readonly onSongAnalysis?: (report: SongAnalysisReport) => void;
}

export interface Engine {
  readonly sampleRate: number;
  status(): StatusReport;
  setMode(mode: PlayMode): void;
  setMix(mix: StemMix): void;
  setKey(semitones: number): void;
  media(sample: MediaSample): void;
  /** Begin the opt-in second pass against the local helper. */
  startDuet(): void;
  /** Replace the saved helper connection, for the next Duet start. */
  setDuetConfig(config: DuetConfig): void;
  setDuetMix(mix: DuetMix): void;
  swapDuet(): void;
  /** Mark a moment in the song as one of the two voices and re-render. */
  anchorDuet(voice: 1 | 2, seconds: number): void;
  clearDuet(): void;
  /** Learn the guide melody from the vocal stem and open the microphone. */
  startPractice(): void;
  /** Release the microphone and forget the analysis. */
  stopPractice(): void;
  /** The microphone desk: level, monitor, effects and compression. */
  setMicFx(fx: MicFx): void;
  /** Begin a take on the stems-and-microphone recording bus. */
  startRecording(): void;
  /** Stop and flush the take. */
  stopRecording(): void;
  dominantHz(): number | null;
  /** The loudest frequency within `spread` Hz of `hz`, for a known partial. */
  peakHz(hz: number, spread?: number): number | null;
  /** The largest absolute sample at the output, or null without an analyser. */
  peakLevel(): number | null;
  debug(): PipelineDebug;
  stop(): Promise<void>;
}

/** One range attempt, then the next: never a tight loop against a bad server. */
const RANGE_ATTEMPTS = 3;

/** What the download has read so far, for the bar and the report. */
interface ReadProgress {
  readonly doneBytes: number;
  readonly totalBytes: number | null;
}

interface ReadStream {
  readonly bytes: ArrayBuffer;
  readonly totalBytes: number | null;
}

function rest(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Reads one range's body, reporting as it goes, and returns the pieces.
 *
 * The pieces are not handed to the caller until the whole range has arrived,
 * so a connection that dies halfway can be asked for again without leaving a
 * duplicate of its first half in the track.
 */
async function readRangeBody(
  response: Response,
  at: number,
  totalBytes: number | null,
  onProgress: (progress: ReadProgress) => void,
): Promise<{ readonly parts: Uint8Array[]; readonly read: number }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const whole = new Uint8Array(await response.arrayBuffer());
    onProgress({ doneBytes: at + whole.byteLength, totalBytes });
    return { parts: [whole], read: whole.byteLength };
  }
  const parts: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    parts.push(step.value);
    read += step.value.byteLength;
    onProgress({ doneBytes: at + read, totalBytes });
  }
  return { parts, read };
}

/**
 * Reads the whole track with bounded range requests.
 *
 * A single GET for a long track gets cut off partway, while a series of
 * megabyte ranges does not, so the audio is read in chunks. The first chunk
 * also discovers the file's length when the page did not know it, from the
 * `Content-Range` header. A server that ignores the range and answers 200 is
 * read as a whole body; the range requests are then unnecessary rather than
 * wrong.
 *
 * A chunk that fails in transit, or arrives short, is asked for again a few
 * times. A 403 is not retried: the signature is refused and will stay refused.
 */
async function readWholeStream(
  url: string,
  knownTotal: number | null,
  onProgress: (progress: ReadProgress) => void,
): Promise<ReadStream> {
  const parts: Uint8Array[] = [];
  let doneBytes = 0;
  let totalBytes = knownTotal;
  let start = 0;

  while (totalBytes === null || start < totalBytes) {
    const wantedEnd =
      totalBytes === null
        ? start + DOWNLOAD_CHUNK_BYTES - 1
        : Math.min(start + DOWNLOAD_CHUNK_BYTES - 1, totalBytes - 1);
    let nextStart = start;
    let failure: unknown = null;

    for (let attempt = 1; attempt <= RANGE_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, { headers: { Range: `bytes=${start}-${String(wantedEnd)}` } });
      } catch (cause) {
        failure = cause;
        await rest(200 * attempt);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        failure = new Error(`the audio could not be read (${String(response.status)})`);
        // A refusal will not become permission by asking again. A server
        // error or a rate limit might.
        if (response.status < 500 && response.status !== 429) {
          throw failure;
        }
        await rest(200 * attempt);
        continue;
      }

      if (response.status === 200) {
        // The server ignored the range. If this is the first request the body
        // is the whole file; any later one would duplicate what is already
        // held, so it is refused rather than stitched in the wrong place.
        if (start !== 0) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error('the audio was sent from the beginning partway through');
        }
        const headerTotal = parseContentLength(response.headers.get('content-length'));
        if (headerTotal !== null) {
          totalBytes = headerTotal;
        }
        const whole = await readRangeBody(response, 0, totalBytes, onProgress);
        for (const part of whole.parts) {
          parts.push(part);
        }
        doneBytes = whole.read;
        totalBytes = totalBytes ?? doneBytes;
        nextStart = doneBytes;
        break;
      }

      const range = parseContentRange(response.headers.get('content-range'));
      if (range === null || range.start !== start) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('the audio arrived out of order');
      }
      if (range.total !== null) {
        totalBytes = range.total;
      }
      const expected = range.end - range.start + 1;
      let body: { readonly parts: Uint8Array[]; readonly read: number };
      try {
        body = await readRangeBody(response, doneBytes, totalBytes, onProgress);
      } catch (cause) {
        failure = cause;
        await rest(200 * attempt);
        continue;
      }
      if (body.read !== expected) {
        failure = new Error('the audio ended early');
        await rest(200 * attempt);
        continue;
      }
      for (const part of body.parts) {
        parts.push(part);
      }
      doneBytes += body.read;
      // A range that came back short of the chunk asked for is the end of the
      // file, for a server that would not say how long the file is.
      if (totalBytes === null && body.read < wantedEnd - start + 1) {
        totalBytes = doneBytes;
      }
      nextStart = range.end + 1;
      break;
    }

    if (nextStart === start) {
      throw failure ?? new Error('the audio could not be read');
    }
    start = nextStart;
  }

  if (totalBytes !== null && doneBytes < totalBytes) {
    throw new Error(`the audio ended early (${String(doneBytes)} of ${String(totalBytes)} bytes)`);
  }
  const bytes = new Uint8Array(doneBytes);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  onProgress({ doneBytes, totalBytes: totalBytes ?? doneBytes });
  return { bytes: bytes.buffer, totalBytes: totalBytes ?? doneBytes };
}

/**
 * The mono analysis copies of the separated stems.
 *
 * They are accumulated at {@link SONG_ANALYSIS_RATE} as the blocks arrive, so
 * three four-minute stems cost about forty megabytes rather than three times
 * that. Nothing here is played: the player's own buffers are the sound, and
 * these are the inputs the song-analysis worker is handed.
 */
interface AnalysisBuffers {
  readonly harmonic: Float32Array;
  readonly percussive: Float32Array;
  readonly vocals: Float32Array;
  readonly harmonicCounts: Float32Array;
  readonly percussiveCounts: Float32Array;
  readonly vocalCounts: Float32Array;
}

/** A stereo pair out of a separated block; either side may be missing. */
type StemPair = readonly [Float32Array | undefined, Float32Array | undefined];

/**
 * Adds one separated block to a mono analysis buffer.
 *
 * The block is averaged by source position rather than by index within the
 * block, so a block boundary cannot become a click, and the count is kept
 * separately because a bucket on a boundary can be shared by two blocks. The
 * division is done once, when the last block is in.
 */
function appendAnalysisBlock(
  pairs: readonly StemPair[],
  startSample: number,
  frames: number,
  target: Float32Array,
  counts: Float32Array,
  inputRate: number,
): void {
  if (pairs.length === 0 || frames <= 0 || target.length === 0) {
    return;
  }
  const ratio = inputRate / SONG_ANALYSIS_RATE;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return;
  }
  const first = Math.max(0, Math.floor(startSample / ratio));
  const last = Math.min(target.length, Math.ceil((startSample + frames) / ratio));
  for (let out = first; out < last; out += 1) {
    const from = Math.max(startSample, Math.floor(out * ratio));
    const to = Math.min(startSample + frames, Math.max(from + 1, Math.floor((out + 1) * ratio)));
    let sum = 0;
    for (let at = from; at < to; at += 1) {
      const frame = at - startSample;
      for (const [left, right] of pairs) {
        sum += ((left?.[frame] ?? 0) + (right?.[frame] ?? 0)) / 2;
      }
    }
    target[out] = (target[out] ?? 0) + sum;
    counts[out] = (counts[out] ?? 0) + (to - from);
  }
}

/** Turns the sums above into averages, once every block has arrived. */
function finishAnalysisBuffer(target: Float32Array, counts: Float32Array): void {
  for (let index = 0; index < target.length; index += 1) {
    const count = counts[index] ?? 0;
    if (count > 0) {
      target[index] = (target[index] ?? 0) / count;
    }
  }
}

export async function startEngine(options: EngineOptions): Promise<Engine> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
  await context.audioWorklet.addModule(options.playbackWorkletUrl);

  const player = new AudioWorkletNode(context, STEM_PLAYER_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  // A tap, not a stage: an analyser passes nothing on and needs nothing
  // downstream, so it cannot colour what is heard even if left running.
  const analyser =
    options.analyse === true
      ? new AnalyserNode(context, { fftSize: ANALYSER_FFT, smoothingTimeConstant: 0 })
      : null;
  const spectrum = analyser === null ? null : new Float32Array(analyser.frequencyBinCount);
  const waveform = analyser === null ? null : new Float32Array(analyser.fftSize);

  const toPlayer = (command: StemPlayerCommand, transfer: Transferable[] = []): void => {
    player.port.postMessage(command, transfer);
  };

  let state: StatusState = nextStatus(IDLE, { type: 'start' });
  /** What the stem cache did, for the report and the panel. */
  let cacheStatus: CacheStatus | null = null;
  // Karaoke is what the button is for: a session that comes up with the vocal
  // still in it would look like the extension had done nothing.
  let mode: PlayMode = options.mode ?? 'instrumental';
  let mix: StemMix = normaliseMix(options.mix ?? DEFAULT_MIX);
  let semitones = clampKey(options.key ?? KEY_DEFAULT);
  /** The video's speed, as the last report gave it. One until told otherwise. */
  let tempo = 1;
  /** The opt-in Voice 1 / Voice 2 pair and the job that produced it. */
  let duet: DuetStatus = IDLE_DUET;
  /** The helper connection the service worker last handed over. */
  let duetConfig: DuetConfig = normaliseDuetConfig(options.duet ?? DEFAULT_DUET_CONFIG);
  let duetActive = false;
  let duetJobId: string | null = null;
  let duetClient: DuetClient | null = null;
  let duetTimer: ReturnType<typeof setTimeout> | null = null;
  /** The complete cache entry for this song, or null when it has none. */
  let duetCacheKey: string | null = null;
  /** The vocal stem, kept as mono so it can be uploaded for the second pass. */
  let vocalsMono: Float32Array | null = null;
  /** The opt-in practice desk, or null when nobody has asked for it. */
  let practice: PracticeHandle | null = null;
  /** The microphone, effects and recorder; null until the graph is made. */
  let mic: MicRoom | null = null;
  /**
   * The melody the last practice pass found. Kept for the session so Sing
   * again after the video ends can open the microphone at once instead of
   * making the singer wait through the same analysis a second time.
   */
  let practiceNotes: readonly PracticeNote[] | null = null;
  /**
   * The analysis copies being filled while separation runs, then the inputs
   * the worker is given, then nothing once the result is in. Three states
   * rather than one: a cancelled run can be retried without re-reading a stem
   * that no longer exists.
   */
  let analysisBuffers: AnalysisBuffers | null = null;
  let analysisInputs: {
    readonly harmonic: Float32Array;
    readonly percussive: Float32Array;
    readonly vocals: Float32Array;
  } | null = null;
  /** The last song-analysis report, and whether asking again would help. */
  let songAnalysis: SongAnalysisReport | null = null;
  let songAnalysisWorker: Worker | null = null;
  let songAnalysisDone = false;

  /** The pitch shifter's delay, which the player has to read ahead by. */
  async function reportedLatency(shifter: StretchNode): Promise<number> {
    const seconds = await shifter.latency();
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * context.sampleRate) : 0;
  }

  let pitch: StretchNode;
  try {
    // The factory would normally build its worklet from a Blob; an extension
    // page cannot load one, so it is pointed at the packed module instead.
    SignalsmithStretch.moduleUrl = options.pitchWorkletUrl;
    pitch = await SignalsmithStretch(context);
  } catch (cause) {
    await context.close();
    throw cause;
  }
  const pitchLatency = await reportedLatency(pitch);
  const route = keyRoute(pitchSemitonesForKey(semitones, tempo), pitchLatency);
  await pitch.schedule({
    active: !route.bypass,
    semitones: pitchSemitonesForKey(semitones, tempo),
  });

  /**
   * The two ways out of the player, crossfaded rather than connected and
   * disconnected. The dry path is the stems themselves; the shifter path is
   * the same stems after the key. Only one is audible after a key settles,
   * and the other is faded to nought.
   */
  const dry = new GainNode(context, { gain: route.bypass ? 1 : 0 });
  const wet = new GainNode(context, { gain: route.bypass ? 0 : 1 });
  player.connect(dry);
  dry.connect(context.destination);
  player.connect(pitch);
  pitch.connect(wet);
  wet.connect(context.destination);
  if (analyser !== null) {
    dry.connect(analyser);
    wet.connect(analyser);
  }
  let routeTarget: 'dry' | 'wet' = route.bypass ? 'dry' : 'wet';
  let routeTurn = 0;
  let routeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Long enough for the shifter to hold the re-aimed head, not the old one. */
  const routePrimeMs = Math.round((pitchLatency / context.sampleRate) * 1000) + ROUTE_PRIME_MS;
  toPlayer({ type: 'latency', samples: route.latencySamples });

  let stopped = false;
  let metrics: Metrics = NO_METRICS;
  /**
   * The last thing the page said about where the video is, kept through the
   * preparation so the first thing the stems do is start where the video is
   * rather than wait up to a quarter of a second for the next tick.
   */
  let latest: MediaSample | null = null;

  /**
   * The decoded track, held only until it has been pushed to the worker.
   * Nulling it once the push starts is what lets the two stereo channels be
   * collected before the eight stem channels are handed to the player.
   */
  let track: { readonly left: Float32Array; readonly right: Float32Array } | null = null;
  let sampleCount = 0;
  /**
   * Frames of stem that have reached the player, in order. The player may
   * play behind this frontier and not ahead of it, which is what lets the
   * vocal switch come alive while the rest is still being separated.
   */
  let stemEnd = 0;
  /** Whether the frontier is far enough past the playhead to take over. */
  let stemsCovered = false;
  let windowsDone = 0;
  let windowsTotal = 0;
  const computeTimes: number[] = [];

  const timings: StageTimings = { ...NO_TIMINGS };
  const startedAt = wallNowMs();
  let download: DownloadFacts | null = null;
  let pieces: Pieces | null = null;
  let progress: PrepareProgress | null = null;
  let durationSeconds: number | null = null;
  let worker: Worker | null = null;
  let backend: PipelineDebug['backend'] = null;
  let backendReason: string | null = null;

  const moveTo = (event: StatusEvent): void => {
    const next = nextStatus(state, event);
    if (next !== state) {
      state = next;
      // A dead end is a dead end for the take too: flush it while the context
      // is still alive rather than leaving the recorder running for a session
      // that has stopped.
      if (next.status === 'error' || next.status === 'unsupported') {
        void mic?.stopRecording();
      }
      tellStatus();
    }
  };

  const report = (): StatusReport => ({
    type: 'status',
    status: state.status,
    reason: state.reason,
    prepare: progress,
    covered: stemsCovered,
    mode,
    mix,
    duet,
    mic: mic?.status() ?? IDLE_MIC_STATUS,
    semitones,
    cache: cacheStatus,
    analyzedSeconds: stemEnd > 0 ? stemEnd / SAMPLE_RATE : null,
    videoId: options.stream.videoId,
    durationSeconds,
  });

  const tellStatus = (): void => {
    options.onStatus(report());
  };

  /**
   * The cache as this session sees it. It reports through the same status
   * channel as everything else, so the panel's one cache row needs no second
   * subscription.
   */
  const cacheSession = new StemCacheSession({
    cache: options.cache ?? stemCache(),
    videoId: options.stream.videoId,
    modelVersion: SEPARATION_MODEL_VERSION,
    sampleRate: context.sampleRate,
    title: '',
    artist: '',
    onStatus: (status) => {
      cacheStatus = status;
      if (!stopped) {
        tellStatus();
      }
    },
  });
  let cacheAvailable = true;

  /**
   * The microphone desk lives beside the stems and records through its own
   * bus: the pitch-shifted stems are connected into it, and the processed
   * microphone joins them there. Monitoring is a second, separate connection
   * to the speakers that starts shut.
   */
  mic = new MicRoom({
    context,
    videoId: options.stream.videoId,
    nowMs: wallNowMs,
    openStream: (constraints) => navigator.mediaDevices.getUserMedia({ audio: constraints }),
    onStatus: () => {
      tellStatus();
    },
    onDownload: (url, filename) => {
      chrome.runtime
        .sendMessage(packet('background', { type: 'request-download', url, filename }))
        .catch(() => undefined);
    },
  });
  pitch.connect(mic.recordInput);

  /**
   * Live metrics are a debug-harness thing. Ten a second relayed through the
   * service worker and out to every tab is a lot of messages for a number
   * nobody reads; the popup's report asks for them once, through `debug()`.
   */
  const tellMetrics = (): void => {
    if (options.analyse === true) {
      options.onMetrics(metrics);
    }
  };

  /**
   * Ask the audio context to run, without waiting for the answer.
   *
   * Chrome may create a document's context suspended and keep a `resume()`
   * pending until something counts as a gesture. The download must not wait
   * on that, so this is fire-and-forget and is called again when there is
   * actually something to play.
   */
  const startClock = (): void => {
    if (context.state === 'running') {
      return;
    }
    void context.resume().catch((cause: unknown) => {
      moveTo({ type: 'error', reason: reasonText(cause) });
    });
  };

  startClock();

  /** The bar, recomputed from what has measurably happened. */
  const bumpProgress = (): void => {
    progress = advanceProgress(
      progress,
      prepareProgress({
        download,
        pieces,
        windowsDone,
        windowsTotal,
        elapsedSeconds: (wallNowMs() - startedAt) / 1000,
        timings: { ...timings, windowMs: medianMs(computeTimes) },
      }),
    );
  };

  const sendMix = (): void => {
    const gains = [...mixGains(mix)];
    if (duetActive) {
      // The pair replaces the single guide; never play both at once.
      gains[3] = 0;
    }
    toPlayer({ type: 'mix', gains, seconds: FADE_SECONDS });
  };

  /** The shifter's one number: the chosen key plus the tempo compensation. */
  const currentShift = (): number => pitchSemitonesForKey(semitones, tempo);

  /** Which side of the graph that shift needs. */
  const wantedRoute = (): 'dry' | 'wet' =>
    keyRoute(currentShift(), pitchLatency).bypass ? 'dry' : 'wet';

  const sendKey = (): void => {
    // The shifter gets one number: the key plus the inverse of the tempo, so
    // reading the stems at the video's rate does not transpose them. Keeping
    // the compensation in this function is deliberate — it is the one place
    // the pitch-shift node is configured.
    void pitch.schedule({ semitones: currentShift() }).catch(() => undefined);
  };

  /**
   * Follows a change of the video's speed.
   *
   * The player reads at the rate and the shifter cancels its transposition;
   * moving the shifter in the same beat as the anchor is what stops a speed
   * change being heard as a key change. A rate outside the player's range is
   * not followed at all, and the page has already handed the sound back.
   */
  const setTempo = (rate: number): void => {
    if (!canFollowTempo(rate) || rate === tempo) {
      return;
    }
    tempo = rate;
    const want = wantedRoute();
    if (want !== routeTarget) {
      setRoute(want);
    } else {
      sendKey();
    }
  };

  /** The player's gain: nought for the video's own sound, one for the stems. */
  const sendMaster = (): void => {
    toPlayer({
      type: 'master',
      target: mode === 'instrumental' ? 1 : 0,
      seconds: FADE_SECONDS,
      shape: 'linear',
    });
  };

  /**
   * Tells the player where the video is, and whether it should be heard.
   *
   * The stems play only where they mean the same thing the video means:
   * moving at a speed the player can follow, and not through an ad.
   * Everything else is the video's own sound, which the content script has
   * unmuted for. The rate is also sent to the shifter first, so the stems
   * never play a tempo change as a key change.
   */
  const follow = (tidy: MediaSample): void => {
    const position = projectMediaSeconds(tidy, wallNowMs());
    const frontierSeconds = stemEnd / SAMPLE_RATE;
    const lead = stemsCovered ? COVER_STOP_LEAD_SECONDS : COVER_START_LEAD_SECONDS;
    const covered = stemEnd > 0 && position < frontierSeconds - lead;
    if (covered !== stemsCovered) {
      stemsCovered = covered;
      // The page mutes on this flag, so it has to hear about the change
      // before the stems start or stop being the sound.
      tellStatus();
    }
    setTempo(tidy.rate);
    const active =
      mode === 'instrumental' &&
      covered &&
      tidy.playing &&
      !tidy.inAd &&
      canFollowTempo(tidy.rate);
    toPlayer({ type: 'playing', playing: active });
    if (active) {
      toPlayer({ type: 'anchor', mediaSeconds: position, rate: tidy.rate });
    }
  };

  /**
   * Moves the stems between the dry path and the shifter, without a click.
   *
   * The two paths do not have the same delay: while the shifter is in, the
   * player reads ahead by its latency and the shifter holds that much audio.
   * So both gains fall to nought first, then the player is re-aimed at the
   * new head and the new path is faded in only after it has had time to fill
   * with the re-aimed audio. The short silence is the price of not playing a
   * stale buffer through the new path.
   */
  const setRoute = (next: 'dry' | 'wet'): void => {
    const turn = ++routeTurn;
    routeTarget = next;
    if (routeTimer !== null) {
      clearTimeout(routeTimer);
      routeTimer = null;
    }
    const at = context.currentTime;
    for (const gain of [dry, wet]) {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(gain.gain.value, at);
      gain.gain.linearRampToValueAtTime(0, at + ROUTE_FADE_SECONDS);
    }
    routeTimer = setTimeout(() => {
      if (turn !== routeTurn) {
        return;
      }
      const active = next === 'wet';
      void pitch.schedule({ active, semitones: currentShift() }).catch(() => undefined);
      toPlayer({ type: 'latency', samples: active ? pitchLatency : 0 });
      // Re-aim now rather than waiting for the next quarter-second tick: the
      // head has to move by the shifter's delay while the output is silent.
      if (latest !== null) {
        follow(latest);
      }
      routeTimer = setTimeout(() => {
        if (turn !== routeTurn) {
          return;
        }
        const now = context.currentTime;
        const target = next === 'dry' ? dry : wet;
        target.gain.cancelScheduledValues(now);
        target.gain.setValueAtTime(0, now);
        target.gain.linearRampToValueAtTime(1, now + ROUTE_FADE_SECONDS);
        routeTimer = null;
      }, active ? routePrimeMs : ROUTE_PRIME_MS);
    }, ROUTE_FADE_SECONDS * 1000);
  };

  const setDuet = (next: Partial<DuetStatus>): void => {
    duet = { ...duet, ...next };
    tellStatus();
  };

  const stopDuetPolling = (): void => {
    if (duetTimer !== null) {
      clearTimeout(duetTimer);
      duetTimer = null;
    }
  };

  /** Hands a pair to the player exactly as the helper result always has. */
  const playDuetPair = (voice1: Float32Array, voice2: Float32Array): void => {
    toPlayer({ type: 'duet', voice1, voice2 }, [
      voice1.buffer as ArrayBuffer,
      voice2.buffer as ArrayBuffer,
    ]);
    duetActive = true;
    sendMix();
    toPlayer({
      type: 'duet-mix',
      gains: duetGains(duet.mix),
      seconds: FADE_SECONDS,
    });
  };

  const loadDuetResult = async (): Promise<void> => {
    if (duetJobId === null || duetClient === null) {
      throw new Error('the helper job is gone');
    }
    const [voice1, voice2] = await duetClient.voices(duetJobId, sampleCount);
    // The player takes ownership of these arrays, so the cache gets its own
    // copies before the transfer. Only when there is an entry to write into.
    const cacheVoices: [Float32Array, Float32Array] | null =
      duetCacheKey === null ? null : [voice1.slice(), voice2.slice()];
    playDuetPair(voice1, voice2);
    const map = await duetClient.map(duetJobId);
    if (cacheVoices !== null && map !== null) {
      // The sidecar is a convenience; the pair is already playing. Without a
      // map there is nothing worth remembering over a previous sidecar.
      void cacheSession.writeCachedDuet(cacheVoices, map.map);
    }
    setDuet({
      state: 'ready',
      progress: null,
      detail: null,
      hasVoices: true,
      lowConfidenceSeconds: map?.lowConfidenceSeconds ?? null,
      source: 'helper',
    });
  };

  const pollDuet = async (): Promise<void> => {
    if (stopped || duetJobId === null || duetClient === null) {
      return;
    }
    try {
      const status = await duetClient.status(duetJobId);
      if (status.state === 'error') {
        throw new Error(status.error ?? 'the helper stopped');
      }
      if (status.state === 'done') {
        await loadDuetResult();
        return;
      }
      setDuet({
        state: 'preparing',
        progress: { phase: status.phase, done: status.done, total: status.total },
        detail: duetPhaseLabel(status.phase),
      });
      scheduleDuetPoll(1000);
    } catch (cause) {
      setDuet({ state: 'error', progress: null, detail: reasonText(cause) });
      stopDuetPolling();
    }
  };

  function scheduleDuetPoll(delay: number): void {
    stopDuetPolling();
    duetTimer = setTimeout(() => {
      void pollDuet();
    }, delay);
  }

  const startDuet = (): void => {
    void (async () => {
      if (duet.state === 'preparing') {
        return;
      }
      if (vocalsMono === null || stemEnd < sampleCount) {
        setDuet({ state: 'error', detail: 'Wait for karaoke to finish preparing.' });
        return;
      }
      try {
        // A pair already in the sidecar is the whole result: no helper, no
        // network, and no token needed. This comes before the token check on
        // purpose, so a replay works while the helper is not running.
        duetCacheKey = await cacheSession.duetEntryKey();
        const cached = await cacheSession.readCachedDuet();
        if (cached !== null && cached.frames === sampleCount) {
          playDuetPair(cached.voice1, cached.voice2);
          setDuet({
            state: 'ready',
            progress: null,
            detail: 'Loaded from cache.',
            hasVoices: true,
            lowConfidenceSeconds: duetLowConfidenceOf(cached.quality),
            source: 'cache',
          });
          return;
        }
        const config = duetConfig;
        if (config.token.length === 0) {
          setDuet({
            state: 'error',
            detail: 'Paste the Duet helper token in the Kara popup.',
          });
          return;
        }
        duetClient = new DuetClient(config, decodeStereo);
        setDuet({
          state: 'preparing',
          progress: { phase: 'starting', done: 0, total: 0 },
          detail: 'Uploading the vocal stem',
          hasVoices: duetActive,
          lowConfidenceSeconds: null,
          source: duetActive ? duet.source : null,
        });
        const wav = encodeWavMono(vocalsMono, context.sampleRate);
        duetJobId = await duetClient.start(wav);
        scheduleDuetPoll(300);
      } catch (cause) {
        setDuet({ state: 'error', progress: null, detail: reasonText(cause) });
        stopDuetPolling();
      }
    })();
  };

  const setDuetMix = (next: DuetMix): void => {
    duet = { ...duet, mix: normaliseDuetMix(next) };
    toPlayer({
      type: 'duet-mix',
      gains: duetGains(duet.mix),
      seconds: FADE_SECONDS,
    });
    tellStatus();
  };

  const setDuetConfig = (next: DuetConfig): void => {
    duetConfig = normaliseDuetConfig(next);
  };

  const swapDuet = (): void => {
    toPlayer({ type: 'duet-swap' });
    tellStatus();
  };

  const anchorDuet = (voice: 1 | 2, seconds: number): void => {
    void (async () => {
      if (duetJobId === null || duetClient === null || duet.state !== 'ready') {
        setDuet({ detail: 'Start Duet before teaching a line.' });
        return;
      }
      const start = Math.max(0, seconds - 1.5);
      const end = seconds + 1.5;
      try {
        setDuet({
          state: 'preparing',
          progress: { phase: 'calibrating', done: 0, total: 0 },
          detail: 'Learning this line',
        });
        await duetClient.anchor(duetJobId, voice, start, end);
        scheduleDuetPoll(500);
      } catch (cause) {
        setDuet({ state: 'ready', progress: null, detail: reasonText(cause) });
        stopDuetPolling();
      }
    })();
  };

  const clearDuet = (): void => {
    stopDuetPolling();
    if (duetJobId !== null && duetClient !== null) {
      void duetClient.cancel(duetJobId).catch(() => undefined);
    }
    duetJobId = null;
    duetClient = null;
    duetActive = false;
    duetCacheKey = null;
    toPlayer({ type: 'duet-clear' });
    duet = IDLE_DUET;
    sendMix();
    tellStatus();
  };

  const stopPractice = (): void => {
    const running = practice;
    practice = null;
    if (running !== null) {
      void running.stop();
    }
  };

  const startPractice = (): void => {
    if (practice?.running() === true) {
      return;
    }
    const room = mic;
    if (room === null) {
      options.onPractice?.({
        type: 'practice-analysis',
        state: 'error',
        progress: null,
        notes: null,
        detail: 'The microphone desk is not ready.',
      });
      return;
    }
    if (vocalsMono === null || sampleCount === 0 || stemEnd < sampleCount) {
      options.onPractice?.({
        type: 'practice-analysis',
        state: 'error',
        progress: null,
        notes: null,
        detail: 'Wait for karaoke to finish preparing before starting practice.',
      });
      return;
    }
    // The worker owns this copy. The duet helper reads the original, so
    // neither feature can detach the other's buffer. A cached melody means
    // there is nothing to analyse again, and the copy is skipped.
    const cached = practiceNotes;
    const copy = cached === null ? vocalsMono.slice() : null;
    const measured = songAnalysis?.facts?.range ?? null;
    practice = startPracticeSession({
      samples: copy,
      sampleRate: context.sampleRate,
      media: () => latest,
      notes: cached,
      range:
        measured === null
          ? null
          : { lowMidi: measured.lowMidi, highMidi: measured.highMidi },
      microphone: {
        acquire: () => room.acquire('practice'),
        release: () => {
          room.release('practice');
        },
      },
      onReport: (report) => {
        if (
          report.type === 'practice-analysis' &&
          report.state === 'ready' &&
          report.notes !== null
        ) {
          practiceNotes = report.notes;
          void cacheSession.savePracticeNotes(report.notes);
        }
        options.onPractice?.(report);
      },
    });
  };

  const tellSongAnalysis = (report: SongAnalysisReport): void => {
    songAnalysis = report;
    options.onSongAnalysis?.(report);
  };

  /**
   * The analysis failed, which is a missing card and not a dead session. The
   * stems keep playing; the person simply gets no key, tempo or range.
   */
  const failSongAnalysis = (detail: string): void => {
    if (stopped) {
      return;
    }
    songAnalysisDone = true;
    const running = songAnalysisWorker;
    songAnalysisWorker = null;
    running?.terminate();
    analysisInputs = null;
    tellSongAnalysis({
      type: 'song-analysis',
      videoId: options.stream.videoId,
      state: 'error',
      progress: null,
      facts: null,
      detail,
    });
  };

  /**
   * Stops the worker without throwing its inputs away. An ad is the reason
   * this exists: the work must not run through one, and leaving it at the
   * pause means the analysis resumes where it can rather than never finishing.
   */
  const cancelSongAnalysis = (detail: string): void => {
    const running = songAnalysisWorker;
    if (running === null) {
      return;
    }
    songAnalysisWorker = null;
    running.terminate();
    if (songAnalysis !== null && songAnalysis.state === 'analyzing') {
      tellSongAnalysis({ ...songAnalysis, progress: 0, detail });
    }
  };

  const startSongAnalysis = (): void => {
    if (
      stopped ||
      songAnalysisDone ||
      songAnalysisWorker !== null ||
      analysisInputs === null ||
      latest?.inAd === true
    ) {
      return;
    }
    const worker = new Worker(new URL('./song-analysis.worker.ts', import.meta.url), {
      type: 'module',
    });
    songAnalysisWorker = worker;
    tellSongAnalysis({
      type: 'song-analysis',
      videoId: options.stream.videoId,
      state: 'analyzing',
      progress: 0,
      facts: null,
      detail: 'Reading the song.',
    });

    worker.addEventListener('message', (event: MessageEvent<SongAnalysisEvent>) => {
      if (stopped || songAnalysisWorker !== worker) {
        return;
      }
      const message = event.data;
      switch (message.type) {
        case 'progress':
          if (songAnalysis !== null) {
            tellSongAnalysis({
              ...songAnalysis,
              state: 'analyzing',
              progress: Math.min(0.99, Math.max(0, message.progress)),
              detail: 'Reading the song.',
            });
          }
          return;
        case 'facts':
          songAnalysisDone = true;
          songAnalysisWorker = null;
          worker.terminate();
          // The result is the only thing kept from here on: the three stems
          // were only ever for this pass.
          analysisInputs = null;
          tellSongAnalysis({
            type: 'song-analysis',
            videoId: options.stream.videoId,
            state: 'ready',
            progress: 1,
            facts: message.facts,
            detail: null,
          });
          void cacheSession.saveAnalysis(message.facts);
          return;
        case 'failed':
          failSongAnalysis(message.reason);
          return;
      }
    });
    worker.addEventListener('error', () => {
      if (songAnalysisWorker !== worker) {
        return;
      }
      failSongAnalysis('The song analysis worker stopped.');
    });

    // Copies, because a cancelled run must leave the session able to try
    // again; the originals stay here until a result is in.
    const inputs = analysisInputs;
    const harmonic = inputs.harmonic.slice();
    const percussive = inputs.percussive.slice();
    const vocals = inputs.vocals.slice();
    worker.postMessage(
      {
        type: 'analyze',
        harmonic,
        percussive,
        vocals,
        sampleRate: SONG_ANALYSIS_RATE,
      } satisfies SongAnalysisCommand,
      [
        harmonic.buffer as ArrayBuffer,
        percussive.buffer as ArrayBuffer,
        vocals.buffer as ArrayBuffer,
      ],
    );
  };

  /** Starts, reschedules after an ad, or leaves a finished analysis alone. */
  const maybeStartSongAnalysis = (): void => {
    if (analysisInputs === null || songAnalysisDone) {
      return;
    }
    if (latest?.inAd === true) {
      cancelSongAnalysis('Waiting for the song to come back.');
      return;
    }
    startSongAnalysis();
  };

  /** Turns the accumulated sums into the three averages the worker wants. */
  const sealAnalysisInputs = (): void => {
    const buffers = analysisBuffers;
    if (buffers === null) {
      return;
    }
    finishAnalysisBuffer(buffers.harmonic, buffers.harmonicCounts);
    finishAnalysisBuffer(buffers.percussive, buffers.percussiveCounts);
    finishAnalysisBuffer(buffers.vocals, buffers.vocalCounts);
    analysisInputs = {
      harmonic: buffers.harmonic,
      percussive: buffers.percussive,
      vocals: buffers.vocals,
    };
    analysisBuffers = null;
  };

  /**
   * Rebuilds the song-analysis inputs from cached stems.
   *
   * This is the fallback for an entry whose analysis was never written — the
   * session stopped before the worker finished, or the entry predates the
   * cached facts. It is a bounded downmix, not a second separation: the four
   * stems are already here.
   */
  const buildCachedAnalysisInputs = (stems: CachedStems): void => {
    const frames = stems.frames;
    const analysisFrames = Math.max(
      1,
      Math.ceil(frames / (context.sampleRate / SONG_ANALYSIS_RATE)) + 1,
    );
    const buffers: AnalysisBuffers = {
      harmonic: new Float32Array(analysisFrames),
      percussive: new Float32Array(analysisFrames),
      vocals: new Float32Array(analysisFrames),
      harmonicCounts: new Float32Array(analysisFrames),
      percussiveCounts: new Float32Array(analysisFrames),
      vocalCounts: new Float32Array(analysisFrames),
    };
    const chunkFrames = Math.round(CHUNK_SECONDS * context.sampleRate);
    for (let start = 0; start < frames; start += chunkFrames) {
      const length = Math.min(chunkFrames, frames - start);
      appendAnalysisBlock(
        [
          [stems.stems.bass.left, stems.stems.bass.right],
          [stems.stems.other.left, stems.stems.other.right],
          [stems.stems.vocals.left, stems.stems.vocals.right],
        ],
        start,
        length,
        buffers.harmonic,
        buffers.harmonicCounts,
        context.sampleRate,
      );
      appendAnalysisBlock(
        [[stems.stems.drums.left, stems.stems.drums.right]],
        start,
        length,
        buffers.percussive,
        buffers.percussiveCounts,
        context.sampleRate,
      );
      appendAnalysisBlock(
        [[stems.stems.vocals.left, stems.stems.vocals.right]],
        start,
        length,
        buffers.vocals,
        buffers.vocalCounts,
        context.sampleRate,
      );
    }
    analysisBuffers = buffers;
    sealAnalysisInputs();
  };

  /**
   * A hit: the four decoded stems go straight into the player.
   *
   * Nothing is fetched, decoded or separated, and no model worker is made.
   * The copies the player needs are the cached arrays themselves; the vocal
   * mono and the analysis inputs are built before the transfer detaches them.
   */
  const loadCachedSession = (hit: Extract<CacheStart, { kind: 'hit' }>): void => {
    const { entry, stems } = hit;
    sampleCount = stems.frames;
    durationSeconds = sampleCount / context.sampleRate;

    const vocalChannels = stems.stems.vocals;
    vocalsMono = new Float32Array(sampleCount);
    for (let frame = 0; frame < sampleCount; frame += 1) {
      vocalsMono[frame] =
        ((vocalChannels.left[frame] ?? 0) + (vocalChannels.right[frame] ?? 0)) / 2;
    }

    // An empty note list is a real cached answer, but passing it to practice
    // would skip the analysis and leave the singer with nothing; treat it as
    // "not cached" so the bounded vocal pass runs instead.
    practiceNotes =
      entry.practiceNotes !== undefined &&
      entry.practiceNotes !== null &&
      entry.practiceNotes.length > 0
        ? entry.practiceNotes
        : null;

    const cachedFacts = entry.analysis ?? null;
    if (cachedFacts === null) {
      // The downmix reads the stems, so it has to happen before the transfer.
      buildCachedAnalysisInputs(stems);
    }

    const channels: Float32Array[] = [];
    for (const stem of STEMS) {
      channels.push(stems.stems[stem].left, stems.stems[stem].right);
    }
    toPlayer(
      { type: 'stems', channels },
      channels.map((channel) => channel.buffer as ArrayBuffer),
    );
    sendMix();
    sendMaster();
    sendKey();
    startClock();
    stemEnd = sampleCount;
    metrics = { ...metrics, stemFrames: sampleCount };
    if (latest !== null) {
      follow(latest);
    }
    moveTo({ type: 'prepared' });
    if (latest !== null && !latest.playing) {
      moveTo({ type: 'hold' });
    }
    // After the status, so the page already knows which video this is: a
    // song-analysis report that loses that race is ignored as stale.
    if (cachedFacts !== null) {
      songAnalysisDone = true;
      tellSongAnalysis({
        type: 'song-analysis',
        videoId: options.stream.videoId,
        state: 'ready',
        progress: 1,
        facts: cachedFacts,
        detail: null,
      });
    } else {
      maybeStartSongAnalysis();
    }
    void cacheSession.markPlayed();
  };

  try {
    cacheStatus = { state: 'checking', bytes: null, detail: null };
    tellStatus();
    try {
      await (options.prepareCache ?? prepareCache)();
    } catch {
      cacheAvailable = false;
      cacheStatus = {
        state: 'error',
        bytes: null,
        detail: 'Cache unavailable.',
      };
      tellStatus();
    }
    const cached = cacheAvailable
      ? await cacheSession.start()
      : ({ kind: 'miss' } as const);
    if (cached.kind === 'hit') {
      loadCachedSession(cached);
    } else {
    const contentLength = Number(options.stream.contentLength);
    const wantedTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
    const read = await readWholeStream(options.stream.url, wantedTotal, (fact) => {
      download = { doneBytes: fact.doneBytes, totalBytes: fact.totalBytes };
      bumpProgress();
      tellStatus();
    });
    const bytes = read.bytes;
    const totalBytes = read.totalBytes;
    // decodeAudioData takes ownership of the buffer and detaches it, so the
    // length is read while there is still a buffer to ask.
    const downloadedBytes = bytes.byteLength;

    const [left, right] = await decodeStereo(bytes);
    track = { left, right };
    sampleCount = left.length;
    vocalsMono = new Float32Array(sampleCount);
    durationSeconds = sampleCount / SAMPLE_RATE;
    const analysisFrames = Math.max(
      1,
      Math.ceil(sampleCount / (context.sampleRate / SONG_ANALYSIS_RATE)) + 1,
    );
    analysisBuffers = {
      harmonic: new Float32Array(analysisFrames),
      percussive: new Float32Array(analysisFrames),
      vocals: new Float32Array(analysisFrames),
      harmonicCounts: new Float32Array(analysisFrames),
      percussiveCounts: new Float32Array(analysisFrames),
      vocalCounts: new Float32Array(analysisFrames),
    };
    timings.downloadSeconds = (wallNowMs() - startedAt) / 1000;
    metrics = { ...metrics, downloadBytes: downloadedBytes, downloadTotal: totalBytes };
    // The frame count is known now, so the cache key is too. A cache failure
    // from here on is a status line, never a reason to stop the separation.
    if (cacheAvailable) {
      cacheSession.beginWrite(sampleCount);
    }

    // The player allocates the whole track now and is filled block by block
    // as the separation reaches it. It can start on the first block instead
    // of waiting for the last one.
    toPlayer({ type: 'begin', frames: sampleCount });
    sendMix();
    sendMaster();
    sendKey();
    startClock();
    metrics = { ...metrics, stemFrames: sampleCount };
    if (latest !== null) {
      follow(latest);
    }

    const separation = new Worker(new URL('../separation/separator.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker = separation;
    separation.addEventListener('message', (event: MessageEvent<SeparatorEvent>) => {
      if (stopped) {
        return;
      }
      const message = event.data;
      switch (message.type) {
        case 'loading':
          pieces = { loaded: message.loaded, total: message.total };
          bumpProgress();
          tellStatus();
          return;
        case 'ready': {
          // The model is loaded and the plan is known: the separating stage
          // opens with its exact total.
          backend = message.backend;
          backendReason = message.backendReason;
          timings.loadingSeconds =
            (wallNowMs() - startedAt) / 1000 - (timings.downloadSeconds ?? 0);
          pieces = null;
          windowsTotal = planJob(sampleCount, message.windowSamples, OVERLAP).total;
          metrics = { ...metrics, windowsTotal };
          bumpProgress();
          tellStatus();
          const whole = track;
          track = null;
          if (whole !== null) {
            pushTrack(whole.left, whole.right);
          }
          return;
        }
        case 'block': {
          if (message.startSample !== stemEnd || stemEnd + message.frames > sampleCount) {
            moveTo({ type: 'error', reason: 'the separated audio arrived out of order' });
            return;
          }
          const channels = message.channels;
          if (vocalsMono !== null) {
            const vocalLeft = channels[6];
            const vocalRight = channels[7];
            for (let frame = 0; frame < message.frames; frame += 1) {
              const at = message.startSample + frame;
              if (at >= vocalsMono.length) {
                break;
              }
              vocalsMono[at] =
                ((vocalLeft?.[frame] ?? 0) + (vocalRight?.[frame] ?? 0)) / 2;
            }
          }
          // The analysis copies are made here, while the block is still in
          // hand: the player takes ownership of these arrays immediately
          // afterwards, so there is no second chance to read them.
          const buffers = analysisBuffers;
          if (buffers !== null) {
            appendAnalysisBlock(
              [
                [channels[2], channels[3]],
                [channels[4], channels[5]],
                [channels[6], channels[7]],
              ],
              message.startSample,
              message.frames,
              buffers.harmonic,
              buffers.harmonicCounts,
              context.sampleRate,
            );
            appendAnalysisBlock(
              [[channels[0], channels[1]]],
              message.startSample,
              message.frames,
              buffers.percussive,
              buffers.percussiveCounts,
              context.sampleRate,
            );
            appendAnalysisBlock(
              [[channels[6], channels[7]]],
              message.startSample,
              message.frames,
              buffers.vocals,
              buffers.vocalCounts,
              context.sampleRate,
            );
          }
          // Copy the block into the cache before the originals are handed to
          // the player. The copy is the only extra work on this path, and the
          // encode happens on the session's own queue.
          if (cacheAvailable) {
            cacheSession.appendBlock(message.startSample, channels);
          }
          // Straight on to the player, which copies it into its own track.
          // The offscreen document does not keep a second set of stems.
          toPlayer(
            {
              type: 'stem-block',
              startSample: message.startSample,
              channels,
            },
            channels.map((channel) => channel.buffer as ArrayBuffer),
          );
          stemEnd += message.frames;
          windowsDone += 1;
          computeTimes.push(message.computeMs);
          metrics = { ...metrics, windowsDone, computeMs: medianMs(computeTimes) };
          bumpProgress();
          tellStatus();
          tellMetrics();
          // The frontier may have just passed the playhead: let the player
          // and the page's mute hear about it now rather than on the next
          // quarter-second tick.
          if (latest !== null) {
            follow(latest);
          }
          return;
        }
        case 'done':
          handStems();
          return;
        case 'failed':
          void cacheSession.abort();
          moveTo({ type: 'error', reason: message.reason });
          return;
      }
    });
    separation.addEventListener('error', () => {
      void cacheSession.abort();
      moveTo({ type: 'error', reason: 'the separation worker stopped' });
    });

    separation.postMessage({
      type: 'init',
      weightsBase: options.weightsBase,
      runtimePath: options.runtimePath,
      sampleRate: context.sampleRate,
    } satisfies SeparatorCommand);

    /** Pushes the whole track, copied a chunk at a time because transfer. */
    function pushTrack(leftTrack: Float32Array, rightTrack: Float32Array): void {
      const chunkFrames = Math.round(CHUNK_SECONDS * SAMPLE_RATE);
      for (let start = 0; start < sampleCount; start += chunkFrames) {
        const end = Math.min(sampleCount, start + chunkFrames);
        const leftChunk = leftTrack.slice(start, end);
        const rightChunk = rightTrack.slice(start, end);
        separation.postMessage(
          {
            type: 'chunk',
            startSample: start,
            left: leftChunk,
            right: rightChunk,
          } satisfies SeparatorCommand,
          [leftChunk.buffer as ArrayBuffer, rightChunk.buffer as ArrayBuffer],
        );
      }
      separation.postMessage({ type: 'flush' } satisfies SeparatorCommand);
    }

    /**
     * The stems are whole. The player already holds them and has been
     * playing them wherever the frontier had reached; the session can now
     * say that the whole track is ready.
     */
    function handStems(): void {
      if (stemEnd !== sampleCount) {
        moveTo({ type: 'error', reason: 'the separated audio ended early' });
        return;
      }
      // Every block is in and the player has the whole track: the cache can
      // close its writer now. This runs beside the transition to ready rather
      // than in front of it.
      if (cacheAvailable) {
        void cacheSession.finish();
      }
      // The frontier covers the whole track now, which may have just made the
      // stems usable at the current playhead.
      if (latest !== null) {
        follow(latest);
      }
      metrics = { ...metrics, stemFrames: sampleCount };
      tellMetrics();
      // The stems are whole, so the analysis copies can stop growing and the
      // key/tempo/range pass can begin — unless an ad is on the clock, in
      // which case it waits for the song to come back.
      sealAnalysisInputs();
      maybeStartSongAnalysis();
      moveTo({ type: 'prepared' });
      // The stems being ready does not make a paused video play. If the last
      // report said the video was holding, the session opens in `paused`
      // rather than claiming to be ready to follow something that is not
      // moving.
      if (latest !== null && !latest.playing) {
        moveTo({ type: 'hold' });
      }
    }

    tellStatus();
    }
    player.port.onmessage = (event: MessageEvent<StemPlayerReport>) => {
      if (stopped) {
        return;
      }
      const playback = event.data;
      metrics = {
        ...metrics,
        playFrame: playback.playFrame,
        mediaSeconds:
          playback.playFrame < 0 || playback.length <= 0
            ? null
            : playback.playFrame / SAMPLE_RATE,
      };
      tellMetrics();
    };

  } catch (cause) {
    void cacheSession.abort();
    moveTo({ type: 'error', reason: reasonText(cause) });
  }

  /**
   * The loudest frequency, optionally only inside a window of the spectrum.
   *
   * The whole-spectrum version is what the debug page shows; the windowed one
   * is what proves a key change. A pitch shifter moves every partial by the
   * same ratio but not by the same amount, so on the three-partial fixture the
   * loudest one can change places after a shift. Looking where a known partial
   * should have gone asks the question that has an answer.
   */
  const peakBetween = (lowHz: number, highHz: number): number | null => {
    if (analyser === null || spectrum === null) {
      return null;
    }
    analyser.getFloatFrequencyData(spectrum);
    const perBin = context.sampleRate / ANALYSER_FFT;
    const low = Math.max(1, Math.floor(lowHz / perBin));
    const high = Math.min(spectrum.length - 2, Math.ceil(highHz / perBin));
    let loudest = Number.NEGATIVE_INFINITY;
    let at = -1;
    for (let bin = low; bin <= high; bin += 1) {
      const level = spectrum[bin] ?? Number.NEGATIVE_INFINITY;
      if (level > loudest) {
        loudest = level;
        at = bin;
      }
    }
    if (at < 0 || !Number.isFinite(loudest) || loudest < ANALYSER_FLOOR_DB) {
      return null;
    }
    const below = spectrum[at - 1] ?? loudest;
    const above = spectrum[at + 1] ?? loudest;
    const curve = below - 2 * loudest + above;
    const offset = curve === 0 ? 0 : (0.5 * (below - above)) / curve;
    return (at + offset) * perBin;
  };

  const dominantHz = (): number | null => {
    if (analyser === null || spectrum === null) {
      return null;
    }
    return peakBetween(0, context.sampleRate / 2);
  };

  const peakHz = (hz: number, spread = 20): number | null => {
    if (!Number.isFinite(hz) || hz <= 0) {
      return null;
    }
    const width = Number.isFinite(spread) && spread > 0 ? spread : 20;
    return peakBetween(hz - width, hz + width);
  };

  /** The largest absolute sample leaving the player, which clipping needs. */
  const peakLevel = (): number | null => {
    if (analyser === null || waveform === null) {
      return null;
    }
    analyser.getFloatTimeDomainData(waveform);
    let peak = 0;
    for (const sample of waveform) {
      const level = Math.abs(sample);
      if (level > peak) {
        peak = level;
      }
    }
    return peak;
  };

  return {
    sampleRate: context.sampleRate,
    status: report,

    setMode(next) {
      mode = next;
      sendMaster();
      // The next media report is up to a quarter of a second away, and the
      // page mutes the video as soon as it sees this mode. Aim the stems and
      // their tempo now so that the sound that takes over is already the
      // right one.
      if (next === 'instrumental' && latest !== null) {
        follow(latest);
      }
      tellStatus();
    },

    setMix(next) {
      mix = normaliseMix(next);
      sendMix();
      tellStatus();
    },

    setKey(next) {
      const wanted = clampKey(next);
      if (wanted === semitones) {
        return;
      }
      semitones = wanted;
      const want = wantedRoute();
      if (want !== routeTarget) {
        setRoute(want);
      } else {
        sendKey();
      }
      tellStatus();
    },

    startDuet,

    setDuetConfig,

    setDuetMix,

    swapDuet,

    anchorDuet,

    clearDuet,

    startPractice,

    stopPractice,

    setMicFx(next) {
      mic?.setFx(next);
    },

    startRecording() {
      void mic?.beginRecording();
    },

    stopRecording() {
      void mic?.stopRecording();
    },

    dominantHz,

    peakHz,

    peakLevel,

    media(sample) {
      if (stopped) {
        return;
      }
      const tidy = tidySample(sample);
      latest = tidy;
      // The page is the only one that knows whether it is moving. A pause
      // while prepared is a hold; a play while held is a resume. Nothing is
      // thrown away in either direction.
      if (state.status === 'ready' && !tidy.playing) {
        moveTo({ type: 'hold' });
      } else if (state.status === 'paused' && tidy.playing) {
        moveTo({ type: 'resume' });
      }
      // While preparing, the player may already have enough stems to follow;
      // `follow` decides that from the frontier and the playhead.
      if (
        state.status === 'preparing' ||
        state.status === 'ready' ||
        state.status === 'paused'
      ) {
        follow(tidy);
      }
      // An ad has no song to analyse. The pass is stopped when one starts and
      // started again when the song does, so it never works on an ad's clock.
      maybeStartSongAnalysis();
    },

    debug: () => ({
      atMs: wallNowMs(),
      status: state.status,
      reason: state.reason,
      sampleRate: context.sampleRate,
      metrics,
      videoId: options.stream.videoId,
      durationSeconds,
      backend,
      backendReason,
    }),

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      // A half-written entry is removed; one already closing is allowed to
      // finish, because a complete song is worth the few milliseconds.
      void cacheSession.abort();
      stopDuetPolling();
      stopPractice();
      if (routeTimer !== null) {
        clearTimeout(routeTimer);
        routeTimer = null;
      }
      const analysis = songAnalysisWorker;
      songAnalysisWorker = null;
      analysis?.terminate();
      analysisBuffers = null;
      analysisInputs = null;
      // Flush any take before the context and the document go away. The
      // recorder's busy loop requests a final chunk and waits for it.
      const room = mic;
      mic = null;
      if (room !== null) {
        await room.dispose();
      }
      if (duetJobId !== null && duetClient !== null) {
        void duetClient.cancel(duetJobId).catch(() => undefined);
      }
      duetJobId = null;
      duetClient = null;
      duetActive = false;
      duetCacheKey = null;
      vocalsMono = null;
      toPlayer({ type: 'stop' });
      const running = worker;
      worker = null;
      if (running !== null) {
        running.postMessage({ type: 'close' } satisfies SeparatorCommand);
        // The worker closes itself once its session is released; this is the
        // backstop for one that cannot.
        setTimeout(() => {
          running.terminate();
        }, 2000);
      }
      player.port.onmessage = null;
      player.disconnect();
      pitch.disconnect();
      dry.disconnect();
      wet.disconnect();
      if (analyser !== null) {
        analyser.disconnect();
      }
      await context.close();
    },
  };
}
