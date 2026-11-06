import { projectMediaSeconds, type MediaSample } from '../audio/media-time.ts';
import { microphoneErrorText } from '../audio/microphone.ts';
import {
  PITCH_CLARITY,
  PITCH_MAX_HZ,
  PITCH_MIN_HZ,
  detectPitch,
  type PitchReading,
} from '../audio/pitch.ts';
import {
  newPracticeScore,
  normalisePracticeNotes,
  practiceScore,
  scorePracticeFrame,
  targetAt,
  type PracticeNote,
  type PracticeScoreState,
} from '../audio/practice.ts';
import { wallNowMs } from '../picture/wall-clock.ts';
import type { PracticeAnalysisReport, PracticeLiveReport } from '../protocol.ts';
import { reasonText } from '../reason.ts';
import type { PracticeCommand, PracticeEvent } from './practice-messages.ts';

/**
 * The live half of pitch practice: analyse the vocal stem, open the
 * microphone, and turn frames into a score.
 *
 * This is deliberately beside `engine.ts` rather than inside it. The engine
 * owns the session's stems and its clock; this owns a worker, a microphone
 * and a reducer, and asks the engine for three things through callbacks —
 * a copied vocal stem, the song's sample rate, and the latest media sample.
 * The normal karaoke path never learns that any of it exists.
 *
 * The microphone is never connected to `context.destination`. A practice room
 * that put the singer through the speakers would feed back, and one that
 * ducked the backing to hide it would be doing something the brief does not
 * ask for. Headphones are the honest answer, and the overlay says so.
 */

/** How often the microphone buffer is read. */
const TICK_MS = 35;

/** How often a live report leaves the document, which is about seventeen a second. */
const REPORT_MS = 55;

/** How often the worker may report progress, to keep the message pump quiet. */
const PROGRESS_MS = 60;

/**
 * How long a pitch that just became uncertain stays on screen. A single
 * consonant or a breath must not make the marker flicker away; the score
 * itself still treats the uncertain frame as a miss.
 */
const PITCH_HOLD_MS = 180;

function microphoneMessage(cause: unknown): string {
  return microphoneErrorText(cause, 'practice');
}

export interface PracticeDeps {
  /**
   * A copy of the separated vocal stem. The caller keeps its own. Null when a
   * note list is supplied and there is nothing to analyse again.
   */
  readonly samples: Float32Array | null;
  readonly sampleRate: number;
  /** The last media report, projected to now by this module. */
  readonly media: () => MediaSample | null;
  /**
   * The engine's microphone desk. Practice shares its stream rather than
   * opening a second one, and takes a reference for as long as it listens.
   */
  readonly microphone: {
    readonly acquire: () => Promise<{
      readonly stream: MediaStream;
      readonly context: AudioContext;
    }>;
    readonly release: () => void;
  };
  /**
   * A melody already learnt for this stem. Sing again reuses it so a second
   * run opens the microphone at once rather than showing the learning state.
   */
  readonly notes?: readonly PracticeNote[] | null;
  readonly onReport: (report: PracticeAnalysisReport | PracticeLiveReport) => void;
}

export interface PracticeHandle {
  /** Whether the microphone and the analysis are still live. */
  running: () => boolean;
  stop: () => Promise<void>;
}

export function startPractice(deps: PracticeDeps): PracticeHandle {
  let stopped = false;
  let active = true;
  let worker: Worker | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let buffer: Float32Array<ArrayBuffer> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Whether this run holds a reference on the engine's shared microphone. */
  let holdsMicrophone = false;
  let notes: readonly PracticeNote[] = [];
  let state: PracticeScoreState = newPracticeScore([]);
  let lastReportMs = 0;
  let lastProgressMs = 0;
  let lastTickMs: number | null = null;
  let lastGood: { readonly reading: PitchReading; readonly atMs: number } | null = null;

  const reportAnalysis = (
    analysisState: 'analyzing' | 'ready' | 'error',
    progress: number | null,
    list: readonly PracticeNote[] | null,
    detail: string | null,
  ): void => {
    if (stopped) {
      return;
    }
    deps.onReport({
      type: 'practice-analysis',
      state: analysisState,
      progress,
      notes: list,
      detail,
    });
  };

  const releaseMicrophone = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    source?.disconnect();
    source = null;
    analyser?.disconnect();
    analyser = null;
    buffer = null;
    context = null;
    if (holdsMicrophone) {
      holdsMicrophone = false;
      deps.microphone.release();
    }
  };

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopping !== null) {
      return stopping;
    }
    stopped = true;
    active = false;
    releaseMicrophone();
    const running = worker;
    worker = null;
    running?.terminate();
    stopping = Promise.resolve();
    return stopping;
  };

  const fail = (detail: string): void => {
    if (stopped) {
      return;
    }
    reportAnalysis('error', null, null, detail);
    active = false;
    void stop();
  };

  const emitLive = (nowMs: number): void => {
    if (stopped || analyser === null || buffer === null || context === null) {
      return;
    }
    // The interval is measured rather than assumed: a throttled timer must
    // not claim the singer only had thirty-five milliseconds of target time.
    const elapsed = lastTickMs === null ? TICK_MS : nowMs - lastTickMs;
    lastTickMs = nowMs;
    const frameSeconds = Math.min(0.2, Math.max(0.01, elapsed / 1000));
    analyser.getFloatTimeDomainData(buffer);
    const reading = detectPitch(buffer, context.sampleRate, {
      minHz: PITCH_MIN_HZ,
      maxHz: PITCH_MAX_HZ,
      minClarity: PITCH_CLARITY,
    });
    const usable = reading.hz !== null && reading.midi !== null && reading.clarity >= PITCH_CLARITY;
    if (usable) {
      lastGood = { reading, atMs: nowMs };
    }
    const held =
      lastGood !== null && nowMs - lastGood.atMs <= PITCH_HOLD_MS ? lastGood : null;
    const shown = usable ? reading : (held?.reading ?? null);

    const sample = deps.media();
    const at = sample === null ? null : projectMediaSeconds(sample, nowMs);
    const listening =
      sample !== null &&
      sample.playing &&
      !sample.inAd &&
      Math.abs(sample.rate - 1) <= 0.001 &&
      at !== null;
    if (listening && at !== null) {
      state = scorePracticeFrame(
        state,
        { at, midi: usable ? reading.midi : null },
        { frameSeconds },
      );
    }
    const target = at === null ? null : targetAt(notes, at);
    const cents =
      shown !== null && target !== null && shown.midi !== null
        ? (shown.midi - target.note.midi) * 100
        : null;

    if (nowMs - lastReportMs < REPORT_MS) {
      return;
    }
    lastReportMs = nowMs;
    deps.onReport({
      type: 'practice-live',
      listening,
      atSeconds: at,
      mic:
        shown === null
          ? null
          : {
              hz: shown.hz,
              midi: shown.midi,
              level: reading.level,
              clarity: shown.clarity,
            },
      target:
        target === null
          ? null
          : {
              index: target.index,
              midi: target.note.midi,
              start: target.note.start,
              end: target.note.end,
            },
      cents,
      score: practiceScore(state),
    });
  };

  const tick = (): void => {
    emitLive(wallNowMs());
  };

  const openMicrophone = async (): Promise<void> => {
    let shared: { readonly stream: MediaStream; readonly context: AudioContext };
    try {
      shared = await deps.microphone.acquire();
    } catch (cause) {
      fail(microphoneMessage(cause));
      return;
    }
    holdsMicrophone = true;
    if (stopped) {
      releaseMicrophone();
      return;
    }
    try {
      context = shared.context;
      if (context.state === 'suspended') {
        await context.resume();
      }
      if (stopped) {
        releaseMicrophone();
        return;
      }
      source = context.createMediaStreamSource(shared.stream);
      analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0 });
      // Only the analyser is connected. The shared microphone is not routed
      // anywhere here; the desk's monitor switch decides that separately.
      source.connect(analyser);
      buffer = new Float32Array(analyser.fftSize);
    } catch (cause) {
      fail(`The microphone could not be prepared: ${reasonText(cause)}`);
      return;
    }

    reportAnalysis('ready', 1, notes, null);
    emitLive(wallNowMs());
    timer = setInterval(tick, TICK_MS);
  };

  const finishAnalysis = (event: Extract<PracticeEvent, { type: 'notes' }>): void => {
    if (stopped) {
      return;
    }
    // One analysis, one list: the worker has nothing left to do and is closed
    // before the microphone opens.
    const finished = worker;
    worker = null;
    finished?.terminate();
    const found = normalisePracticeNotes(event.notes);
    if (found.length === 0) {
      fail('No guide melody could be read from this vocal stem. Try another song or section.');
      return;
    }
    notes = found;
    state = newPracticeScore(notes);
    reportAnalysis('ready', 1, notes, 'Listening for the guide melody.');
    void openMicrophone();
  };

  const nest = (): void => {
    const samples = deps.samples;
    if (samples === null) {
      fail('No vocal stem was available for practice.');
      return;
    }
    const made = new Worker(new URL('./practice.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker = made;
    made.addEventListener('message', (event: MessageEvent<PracticeEvent>) => {
      if (stopped) {
        return;
      }
      const message = event.data;
      switch (message.type) {
        case 'progress': {
          const now = wallNowMs();
          if (now - lastProgressMs < PROGRESS_MS && message.progress < 1) {
            return;
          }
          lastProgressMs = now;
          reportAnalysis('analyzing', message.progress, null, 'Learning the guide melody.');
          return;
        }
        case 'notes':
          finishAnalysis(message);
          return;
        case 'failed':
          fail(message.reason);
          return;
      }
    });
    made.addEventListener('error', () => {
      fail('The practice analysis worker stopped.');
    });
    made.postMessage(
      {
        type: 'analyze',
        samples,
        sampleRate: deps.sampleRate,
      } satisfies PracticeCommand,
      [samples.buffer as ArrayBuffer],
    );
  };

  const cached =
    deps.notes === undefined || deps.notes === null ? null : normalisePracticeNotes(deps.notes);
  if (cached !== null && cached.length > 0) {
    notes = cached;
    state = newPracticeScore(notes);
    reportAnalysis('ready', 1, notes, null);
    void openMicrophone();
  } else {
    reportAnalysis('analyzing', 0, null, 'Learning the guide melody.');
    nest();
  }

  return {
    running: () => active && !stopped,
    stop,
  };
}
