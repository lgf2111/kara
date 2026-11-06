import {
  DOWNLOAD_CHUNK_BYTES,
  parseContentLength,
  parseContentRange,
} from '../audio/download.ts';
import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';

import { clampKey, KEY_DEFAULT } from '../audio/key.ts';
import { decodeStereo } from '../audio/decode.ts';
import { DuetClient } from '../audio/duet-client.ts';
import { projectMediaSeconds, tidySample, type MediaSample } from '../audio/media-time.ts';
import { FADE_SECONDS, type PlayMode } from '../audio/mix-gain.ts';
import {
  DUET_CONFIG_KEY,
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
import type { PracticeNote } from '../audio/practice.ts';
import { startPractice as startPracticeSession, type PracticeHandle } from './practice.ts';
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
import { DEFAULT_MIX, mixGains, normaliseMix, type StemMix } from '../audio/stems.ts';
import {
  STEM_PLAYER_PROCESSOR,
  type StemPlayerCommand,
  type StemPlayerReport,
} from '../audio/stem-player-messages.ts';
import { wallNowMs } from '../picture/wall-clock.ts';
import { reasonText } from '../reason.ts';
import type { SeparatorCommand, SeparatorEvent } from '../separation/messages.ts';
import { SAMPLE_RATE } from '../separation/model.ts';
import type {
  Metrics,
  PipelineDebug,
  PracticeAnalysisReport,
  PracticeLiveReport,
  StatusReport,
  StreamInfo,
} from '../protocol.ts';
import { NO_METRICS } from '../protocol.ts';
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
  /** Taps the output with an `AnalyserNode`, for the debug harness only. */
  readonly analyse?: boolean;
  readonly onStatus: (report: StatusReport) => void;
  readonly onMetrics: (metrics: Metrics) => void;
  /** Practice analysis and live reports, when a person has opted in. */
  readonly onPractice?: (report: PracticeAnalysisReport | PracticeLiveReport) => void;
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
  setDuetMix(mix: DuetMix): void;
  swapDuet(): void;
  /** Mark a moment in the song as one of the two voices and re-render. */
  anchorDuet(voice: 1 | 2, seconds: number): void;
  clearDuet(): void;
  /** Learn the guide melody from the vocal stem and open the microphone. */
  startPractice(): void;
  /** Release the microphone and forget the analysis. */
  stopPractice(): void;
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
  // Karaoke is what the button is for: a session that comes up with the vocal
  // still in it would look like the extension had done nothing.
  let mode: PlayMode = options.mode ?? 'instrumental';
  let mix: StemMix = normaliseMix(options.mix ?? DEFAULT_MIX);
  let semitones = clampKey(options.key ?? KEY_DEFAULT);
  /** The opt-in Voice 1 / Voice 2 pair and the job that produced it. */
  let duet: DuetStatus = IDLE_DUET;
  let duetActive = false;
  let duetJobId: string | null = null;
  let duetClient: DuetClient | null = null;
  let duetTimer: ReturnType<typeof setTimeout> | null = null;
  /** The vocal stem, kept as mono so it can be uploaded for the second pass. */
  let vocalsMono: Float32Array | null = null;
  /** The opt-in practice desk, or null when nobody has asked for it. */
  let practice: PracticeHandle | null = null;
  /**
   * The melody the last practice pass found. Kept for the session so Sing
   * again after the video ends can open the microphone at once instead of
   * making the singer wait through the same analysis a second time.
   */
  let practiceNotes: readonly PracticeNote[] | null = null;

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
    await pitch.schedule({ active: true, semitones });
  } catch (cause) {
    await context.close();
    throw cause;
  }
  const pitchLatency = await reportedLatency(pitch);
  player.connect(pitch);
  pitch.connect(context.destination);
  if (analyser !== null) {
    pitch.connect(analyser);
  }
  toPlayer({ type: 'latency', samples: pitchLatency });

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
    semitones,
    analyzedSeconds: stemEnd > 0 ? stemEnd / SAMPLE_RATE : null,
    videoId: options.stream.videoId,
    durationSeconds,
  });

  const tellStatus = (): void => {
    options.onStatus(report());
  };

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

  const sendKey = (): void => {
    void pitch.schedule({ semitones }).catch(() => undefined);
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
   * moving at the normal rate, and not through an ad. Everything else is the
   * video's own sound, which the content script has unmuted for.
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
    const active =
      mode === 'instrumental' && covered && tidy.playing && !tidy.inAd && tidy.rate === 1;
    toPlayer({ type: 'playing', playing: active });
    if (active) {
      toPlayer({ type: 'anchor', mediaSeconds: position, rate: tidy.rate });
    }
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

  const loadDuetConfig = async (): Promise<DuetConfig> => {
    const stored = await chrome.storage.local.get(DUET_CONFIG_KEY);
    return normaliseDuetConfig(stored[DUET_CONFIG_KEY]);
  };

  const loadDuetResult = async (): Promise<void> => {
    if (duetJobId === null || duetClient === null) {
      throw new Error('the helper job is gone');
    }
    const [voice1, voice2] = await duetClient.voices(duetJobId, sampleCount);
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
    const low = await duetClient.lowConfidence(duetJobId);
    setDuet({
      state: 'ready',
      progress: null,
      detail: null,
      hasVoices: true,
      lowConfidenceSeconds: low,
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
        const config = await loadDuetConfig();
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
    practice = startPracticeSession({
      samples: copy,
      sampleRate: context.sampleRate,
      media: () => latest,
      notes: cached,
      onReport: (report) => {
        if (
          report.type === 'practice-analysis' &&
          report.state === 'ready' &&
          report.notes !== null
        ) {
          practiceNotes = report.notes;
        }
        options.onPractice?.(report);
      },
    });
  };

  try {
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
    timings.downloadSeconds = (wallNowMs() - startedAt) / 1000;
    metrics = { ...metrics, downloadBytes: downloadedBytes, downloadTotal: totalBytes };

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
          moveTo({ type: 'error', reason: message.reason });
          return;
      }
    });
    separation.addEventListener('error', () => {
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
      // The frontier covers the whole track now, which may have just made the
      // stems usable at the current playhead.
      if (latest !== null) {
        follow(latest);
      }
      metrics = { ...metrics, stemFrames: sampleCount };
      tellMetrics();
      moveTo({ type: 'prepared' });
      // The stems being ready does not make a paused video play. If the last
      // report said the video was holding, the session opens in `paused`
      // rather than claiming to be ready to follow something that is not
      // moving.
      if (latest !== null && !latest.playing) {
        moveTo({ type: 'hold' });
      }
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

    tellStatus();
  } catch (cause) {
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
      sendKey();
      tellStatus();
    },

    startDuet,

    setDuetMix,

    swapDuet,

    anchorDuet,

    clearDuet,

    startPractice,

    stopPractice,

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
      stopDuetPolling();
      stopPractice();
      if (duetJobId !== null && duetClient !== null) {
        void duetClient.cancel(duetJobId).catch(() => undefined);
      }
      duetJobId = null;
      duetClient = null;
      duetActive = false;
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
      if (analyser !== null) {
        analyser.disconnect();
      }
      await context.close();
    },
  };
}
