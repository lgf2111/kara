import { createCaptureClock } from '../audio/capture-clock.ts';
import {
  grownDelaySeconds,
  initialDelaySeconds,
  MAX_DELAY_SECONDS,
  needsCatchUp,
  shortfallSeconds,
  type DelayChange,
} from '../audio/delay-plan.ts';
import { createEventLog, stackOf, type EventData, type EventKind } from '../audio/event-log.ts';
import { clampKey, KEY_DEFAULT } from '../audio/key.ts';
import { createMediaMap } from '../audio/media-map.ts';
import { createMediaClock, type MediaSample } from '../audio/media-time.ts';
import {
  CROSSFADE_SECONDS,
  crossfadeOutCurve,
  FADE_IN_SECONDS,
  FADE_SECONDS,
  guideLevel,
  MUTE_SECONDS,
  vocalGainFor,
  type FadeShape,
  type PlayMode,
} from '../audio/mix-gain.ts';
import {
  advanceProgress,
  NO_TIMINGS,
  prepareProgress,
  WINDOW_SECONDS,
  type Pieces,
  type PrepareProgress,
  type PrepareStage,
} from '../audio/progress.ts';
import {
  IDLE,
  isAudible,
  isRunning,
  nextStatus,
  type StatusEvent,
  type StatusState,
} from '../audio/status.ts';
import {
  CAPTURE_PROCESSOR,
  INSTRUMENTAL_LEFT,
  PLAYBACK_PROCESSOR,
  VOCALS_LEFT,
  type CaptureCommand,
  type CaptureEvent,
  type PlaybackCommand,
  type PlaybackEvent,
} from '../audio/worklet-messages.ts';
import type { SeparatorCommand, SeparatorEvent } from '../separation/messages.ts';
import { SAMPLE_RATE } from '../separation/model.ts';
import { wallNowMs } from '../picture/wall-clock.ts';
import { reasonText } from '../reason.ts';
import { DEFAULT_SETTINGS, type OnReady } from '../settings.ts';
import type { PipelineDebug } from '../debug-report.ts';
import {
  NO_METRICS,
  type BlockStat,
  type CatchUp,
  type Metrics,
  type ResetReason,
  type StatusReport,
} from '../protocol.ts';

/**
 * Tab audio in, the same audio separated and sixteen seconds late out.
 *
 * Left to right: a `MediaStream` from `chrome.tabCapture` feeds a capture
 * worklet that stamps each chunk with the context time it arrived at; the
 * chunks go to a worker running the streaming separator on WebGPU; finalised
 * blocks come back and are written into the playback worklet's ring at the
 * absolute sample they belong to; the player reads them out when the delay
 * says their moment has come, mixes them and changes the key on the way out.
 *
 * Six things are worth knowing before reading on.
 *
 * **The song's own clock is the clock.** Everything inside the audio is timed
 * on the `AudioContext`, because that is the only clock a worklet has. But
 * what a sample *is* — which moment of which song — is media time, reported by
 * the content script four times a second as `{wallMs, mediaSeconds, playing,
 * rate}`. `audio/media-time.ts` turns those reports into one answer per
 * captured chunk, and `audio/media-map.ts` keeps the two directions anybody
 * needs: which audio to keep, and where in the song a processed sample sits.
 *
 * **Capture taken while the song was not moving is thrown away.** A YouTube
 * buffering stall leaves `currentTime` standing still while the capture keeps
 * running, and feeding that to the separator staples a stretch of silence into
 * the middle of the song — which moved every frame after it out of step with
 * the words by exactly as long as the stall, with nothing to put it back. So
 * those chunks never reach the separator, and the processed timeline is
 * contiguous in media time by construction. Paused, waiting, stalled and an
 * ad's own timeline are the same case.
 *
 * **A reset is a media-time discontinuity and nothing else.** Not a `seeking`
 * event: the page fires those for buffering, for a quality change, for
 * adopting a new source and at the start of playback, and obeying them cost
 * the whole delay for nothing. A jump of more than three quarters of a second
 * that standing still cannot explain is a seek; everything else carries on.
 * A rate change, the end, an ad boundary and another video still reset,
 * because each of those really is another timeline.
 *
 * **The delay is measured, and it may grow.** The separator reports what its
 * finalised audio is late by — a window, plus a hop, plus what a window costs
 * on this machine — and the margin on top is a fraction of that cost rather
 * than a constant. It never shrinks during a song, because a picture must
 * never jump forwards, but it grows when the output starts to starve: a window
 * that cost 2.2 s at the start of a song costs 3.2 s four minutes in, and what
 * used to happen then was silence for the rest of the song. `catching up` is
 * that growth being made up, and `audio/delay-plan.ts` is the arithmetic.
 *
 * **Getting ready is four stages, and it reports which one it is in.** There
 * is no countdown: loading the model, hearing the first window, separating it
 * and waiting for its moment are four different waits of four different
 * lengths, and `audio/progress.ts` maps what has measurably happened onto a
 * fraction of a bar. Nothing of it advances while the page is paused, and a
 * start on a paused video waits rather than separating silence.
 *
 * **A pause is not a reset.** Pausing holds: the capture stops being fed, the
 * player freezes where it is and the epoch moves forward by however long that
 * lasted, so a resume carries on from the same sample with the same delay.
 *
 * **Capture mutes the tab.** Whatever leaves the player is the only thing the
 * person hears. So priming is silence unless passthrough is asked for, and a
 * machine that cannot separate live says so rather than playing nothing for
 * ever.
 */

/**
 * Seconds of separated audio the ring holds.
 *
 * Everything between the real lag and the delay is queued in it, so this has
 * to cover the largest gap the two can open up — which is the cap on how far
 * the delay may grow to catch up, plus a hop's worth of sawtooth. A ring
 * shorter than that would drop the blocks the extra delay was bought to
 * protect, which is the failure this whole arrangement exists to end.
 */
const RING_SECONDS = 24;

/**
 * How often the output's place in the song and the counters go out. Ten times
 * a second, because the picture is painted from the first of those.
 */
const METRICS_TICK_MS = 100;

/** Seconds between drift samples in the event log. Cheap, and bounded. */
const DRIFT_LOG_SECONDS = 10;

/**
 * How long a measured shortfall counts for. A block that arrived late four
 * seconds ago says nothing about now, and the queue is measured ten times a
 * second anyway.
 */
const SHORTFALL_MEMORY_SECONDS = 4;

/** Frames between sparse samples when measuring how loud a block is. */
const RMS_STEP = 64;

/**
 * How often a status report goes out while getting ready. The bar is built
 * from measurements rather than counted down from one, so it has to be
 * recomputed and sent rather than extrapolated by whoever is drawing it —
 * which is exactly what the countdown this replaced got wrong.
 */
const PREPARE_TICK_MS = 250;

/**
 * How long a transform the dominant-frequency tap uses: about 1.3 Hz a bin at
 * 44.1 kHz, which is well inside a semitone anywhere it matters. Only built
 * when something asks for it, which is the debug harness and nothing else.
 */
const ANALYSER_FFT = 32768;

/** Below this much, the loudest bin is the noise floor rather than a note. */
const ANALYSER_FLOOR_DB = -90;

export interface PipelineOptions {
  /** The tab's audio, and the only audio this extension ever touches. */
  readonly stream: MediaStream;
  readonly weightsBase: string;
  readonly runtimePath: string;
  readonly captureWorkletUrl: string;
  readonly playbackWorkletUrl: string;
  readonly mode?: PlayMode;
  readonly guide?: number;
  /** The key to start in, in semitones. The remembered default, usually. */
  readonly key?: number;
  /** Play the tab's own audio, undelayed, while priming. Off by default. */
  readonly passthrough?: boolean;
  /** What happens at the moment the delayed audio is ready. */
  readonly onReady?: OnReady;
  readonly onStatus: (report: StatusReport) => void;
  readonly onMetrics: (metrics: Metrics) => void;
  /** Per finalised block, for the debug harness. Costs a sparse scan. */
  readonly onBlock?: (stat: BlockStat) => void;
  /**
   * Taps the output with an `AnalyserNode` so `dominantHz` can answer. For the
   * debug harness, which is the only thing that needs to prove the key moved
   * the pitch; the packed extension never asks and never builds one.
   */
  readonly analyse?: boolean;
}

export interface Pipeline {
  readonly sampleRate: number;
  status(): StatusReport;
  metrics(): Metrics;
  setMode(mode: PlayMode): void;
  setGuide(level: number): void;
  /** The key, in semitones, which the player's last stage applies. */
  setKey(semitones: number): void;
  setPassthrough(enabled: boolean): void;
  setOnReady(onReady: OnReady): void;
  /**
   * The loudest frequency leaving the player, or null when nothing asked for
   * the tap or there is nothing above the noise floor.
   */
  dominantHz(): number | null;
  /**
   * Where the page says it is in the song. Four times a second and on every
   * media event, from whoever owns the page: the content script, or the debug
   * harness pretending to be one.
   */
  media(sample: MediaSample): void;
  /** Throws away what is buffered and primes again, for a seek or an ad. */
  reset(reason: ResetReason): void;
  /** Freezes the output where it is and keeps everything, for a pause. */
  hold(): void;
  /** And carries on from the same sample, with the same delay. */
  resume(): void;
  /** The event log and the measurements, for the popup's copy button. */
  debug(): PipelineDebug;
  /**
   * Adds artificial compute time to every window, so that starvation can be
   * provoked on a machine fast enough never to starve by itself. The harness
   * asks; the packed extension never does.
   */
  slowSeparation(ms: number): void;
  stop(): Promise<void>;
}

/** Loudness of a sparse sample of a channel: enough to prove it has audio. */
function sparseRms(channel: Float32Array | undefined): number {
  if (channel === undefined) {
    return 0;
  }
  let sum = 0;
  let counted = 0;
  for (let index = 0; index < channel.length; index += RMS_STEP) {
    const value = channel[index] ?? 0;
    sum += value * value;
    counted += 1;
  }
  return counted === 0 ? 0 : Math.sqrt(sum / counted);
}

/** Transfer list for a set of channels, which are handed over, not shared. */
function buffersOf(channels: readonly Float32Array[]): Transferable[] {
  return channels.map((channel) => channel.buffer as ArrayBuffer);
}

/**
 * A moment on the context clock, with the pauses up to it counted, so that
 * time spent frozen can be taken out of whatever is measured from it.
 */
interface Mark {
  readonly at: number;
  readonly held: number;
}

export async function startPipeline(options: PipelineOptions): Promise<Pipeline> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
  await context.audioWorklet.addModule(options.captureWorkletUrl);
  await context.audioWorklet.addModule(options.playbackWorkletUrl);

  const source = context.createMediaStreamSource(options.stream);
  const capture = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    // Explicit, so a mono tab is up-mixed once, here, rather than guessed at
    // further down: the model was trained on stereo.
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  const player = new AudioWorkletNode(context, PLAYBACK_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { ringSeconds: RING_SECONDS },
  });
  /** The capture's output is silent and exists only so the node is pulled. */
  const sink = new GainNode(context, { gain: 0 });
  const passthrough = new GainNode(context, { gain: 0 });

  source.connect(capture).connect(sink).connect(context.destination);
  source.connect(passthrough).connect(context.destination);
  player.connect(context.destination);

  // A tap, not a stage: an analyser passes nothing on and needs nothing
  // downstream, so it cannot colour what is heard even if it is left running.
  const analyser =
    options.analyse === true
      ? new AnalyserNode(context, { fftSize: ANALYSER_FFT, smoothingTimeConstant: 0 })
      : null;
  const spectrum = analyser === null ? null : new Float32Array(analyser.frequencyBinCount);
  if (analyser !== null) {
    player.connect(analyser);
  }

  const worker = new Worker(new URL('../separation/separator.worker.ts', import.meta.url), {
    type: 'module',
  });
  /**
   * The capture clock counts kept samples only, and is re-anchored on the
   * first chunk after a discarded stretch. That is what makes a sample index
   * mean the same thing to it and to the map below: both advance for kept
   * audio and neither for anything else.
   */
  const clock = createCaptureClock(context.sampleRate);
  const media = createMediaClock();
  const map = createMediaMap(context.sampleRate);
  const log = createEventLog();

  let state: StatusState = nextStatus(IDLE, { type: 'start' });
  let mode: PlayMode = options.mode ?? 'instrumental';
  let guide = guideLevel(options.guide ?? 0);
  let semitones = clampKey(options.key ?? KEY_DEFAULT);
  let passing = options.passthrough ?? false;
  let onReady: OnReady = options.onReady ?? DEFAULT_SETTINGS.onReady;
  let measured: Metrics = NO_METRICS;
  let primeTimer: ReturnType<typeof setTimeout> | null = null;
  let prepareTicker: ReturnType<typeof setInterval> | null = null;

  /** Null until the first block of this timeline has been measured. */
  let delaySeconds: number | null = null;
  /** Context time the first delayed sample is due, or null before that. */
  let liveAt: number | null = null;
  /** Why it is priming again, when it is not the first time. */
  let reprime: ResetReason | null = null;

  /** Every delay this timeline has settled on, for the report and the harness. */
  let delays: DelayChange[] = [];
  /** Seconds the delay has grown by since this timeline began. */
  let addedSeconds = 0;
  /** Context time the latest growth has been made up by, or null when none is. */
  let catchUpUntil: number | null = null;
  /** The growth being made up, so its progress can be reported. */
  let catchUpSpan = 0;
  /** Starved frames seen since the last time the delay was reconsidered. */
  let starvedFrames = 0;
  let lastUnderrun = 0;
  /** The worst lateness measured recently, and when, so it can go stale. */
  let lateSeconds = 0;
  let lateAt = 0;
  /** Frames queued ahead of the output, from the player's own count. */
  let queuedFrames = 0;
  /** Frames of a discarded stretch so far, so one line is logged per stretch. */
  let discarding = 0;
  let discardingStalled = false;
  let driftLoggedAt = 0;
  let metricsSentAt = 0;

  /** Seconds the output has been frozen by pauses since the last reset. */
  let heldTotal = 0;
  /** Context time the output froze at, or null while it is moving. */
  let heldFrom: number | null = null;
  /**
   * The same thing as the player measured it, which is the number that leaves
   * this file.
   *
   * Two halves are counting the same two events on the same clock and they
   * agree to within a render quantum, so the difference does not matter — but
   * one of them has to be the one the picture is shifted by, and it should be
   * the half that actually froze. The player's own count is it. What is kept
   * here is for this file's own timers and its own progress bar.
   */
  let heldReported = 0;

  /**
   * Chunks are dropped until the model is loaded, and the clock is restarted
   * when it is. Twenty-one graph pieces take a while to compile, and audio
   * captured in the meantime would put the separator's sample zero somewhere
   * the clock had already passed, which would make every measurement wrong.
   */
  let ready = false;
  let capturing = true;
  let stopped = false;

  /**
   * What each stage of getting ready cost, filled in as each of them ends and
   * kept across resets: the model is only loaded once, and a later prime's
   * estimate is the earlier prime's measurement.
   */
  const timings: Record<PrepareStage, number | null> = { ...NO_TIMINGS };
  let pieces: Pieces | null = null;
  let windowSeconds = WINDOW_SECONDS;
  /** A hop, which is the least the first window can take to come back. */
  let hopSeconds = WINDOW_SECONDS * 0.75;
  /** The high-water mark, so the bar never retreats. */
  let progress: PrepareProgress | null = null;

  let primeMark: Mark = { at: context.currentTime, held: 0 };
  let listenMark: Mark | null = null;
  let separateMark: Mark | null = null;
  let fillMark: Mark | null = null;
  /** Seconds between the first block arriving and its moment, fixed then. */
  let fillSeconds = 0;

  /** Seconds the output has been frozen, counting one in progress. */
  const heldNow = (): number =>
    heldTotal + (heldFrom === null ? 0 : Math.max(0, context.currentTime - heldFrom));

  const markNow = (): Mark => ({ at: context.currentTime, held: heldNow() });

  /** Seconds of running time since a mark, with any pause taken out. */
  const since = (mark: Mark): number =>
    Math.max(0, context.currentTime - mark.at - (heldNow() - mark.held));

  const held = (): boolean => heldFrom !== null;

  /** Audio heard since the separator was ready: the one stage the capture counts. */
  const listenedSeconds = (): number | null =>
    listenMark === null ? null : clock.samples / context.sampleRate;

  /**
   * Where the bar is, advanced rather than recomputed from scratch, so that a
   * better guess at what a window costs cannot make it go backwards. Frozen
   * while the page is paused, because nothing is happening.
   */
  const progressNow = (): PrepareProgress | null => {
    if (state.status === 'paused') {
      return progress;
    }
    if (state.status !== 'priming') {
      return null;
    }
    progress = advanceProgress(
      progress,
      prepareProgress({
        modelPieces: pieces,
        loadingSeconds: since(primeMark),
        listenedSeconds: listenedSeconds(),
        windowSeconds,
        separatingSeconds: separateMark === null ? null : since(separateMark),
        expectedSeparateSeconds: timings.separating ?? hopSeconds,
        fillingSeconds: fillMark === null ? null : since(fillMark),
        fillSeconds,
        timings,
      }),
    );
    return progress;
  };

  /** Notes what a stage cost, which is the only estimate ever offered. */
  const timed = (stage: PrepareStage, seconds: number): void => {
    timings[stage] = Math.max(0, seconds);
  };

  /** One line in the ring the popup copies. Never audio, never an address. */
  const note = (
    kind: EventKind,
    what: string,
    data: EventData | null = null,
    stack: string | null = null,
  ): void => {
    log.add(kind, what, data, stack);
  };

  /** How far through making the latest growth up, or null when none is. */
  const catchUp = (): CatchUp | null => {
    if (addedSeconds <= 0) {
      return null;
    }
    if (catchUpUntil === null || catchUpSpan <= 0) {
      return { addedSeconds, fraction: 1 };
    }
    const left = Math.max(0, catchUpUntil - context.currentTime);
    return { addedSeconds, fraction: Math.min(1, Math.max(0, 1 - left / catchUpSpan)) };
  };

  /**
   * Whether nothing can happen until somebody presses play: a start on a
   * paused video, which used to capture silence and start the timeline on it.
   */
  const waitingForPlay = (): boolean => {
    if (delaySeconds !== null || clock.samples > 0 || !isRunning(state.status)) {
      return false;
    }
    return held() || media.newest?.playing === false;
  };

  const report = (): StatusReport => ({
    type: 'status',
    status: state.status,
    reason: state.reason,
    prepare: progressNow(),
    reprime,
    delaySeconds,
    heldSeconds: heldReported,
    catchUp: catchUp(),
    waitingForPlay: waitingForPlay(),
    mode,
    guide,
    semitones,
    onReady,
  });

  const tellStatus = (): void => {
    options.onStatus(report());
  };

  const tellMetrics = (): void => {
    metricsSentAt = context.currentTime;
    measured = {
      ...measured,
      delaySeconds,
      addedDelaySeconds: addedSeconds,
      heldSeconds: heldReported,
      driftMs: clock.driftSeconds * 1000,
      droppedSeconds: map.droppedSeconds,
      jumps: map.jumps,
    };
    options.onMetrics(measured);
  };

  /** The bar only moves while something is moving it. */
  const watchPrepare = (): void => {
    const wanted = state.status === 'priming' && !stopped;
    if (wanted && prepareTicker === null) {
      prepareTicker = setInterval(tellStatus, PREPARE_TICK_MS);
      return;
    }
    if (!wanted && prepareTicker !== null) {
      clearInterval(prepareTicker);
      prepareTicker = null;
    }
  };

  const moveTo = (event: StatusEvent): void => {
    const next = nextStatus(state, event);
    if (next !== state) {
      state = next;
      watchPrepare();
      tellStatus();
    }
  };

  const toPlayer = (command: PlaybackCommand, transfer: Transferable[] = []): void => {
    player.port.postMessage(command, transfer);
  };

  const toCapture = (command: CaptureCommand): void => {
    capture.port.postMessage(command);
  };

  const toSeparator = (command: SeparatorCommand, transfer: Transferable[] = []): void => {
    worker.postMessage(command, transfer);
  };

  const sendGain = (seconds: number): void => {
    toPlayer({ type: 'gain', target: vocalGainFor(mode, guide), seconds });
  };

  /**
   * The key. Sent once at the start and once per change, and never on a reset:
   * the player's shifter keeps it across a flush, because a seek is not the
   * person changing their mind about what key to sing in.
   */
  const sendKey = (): void => {
    toPlayer({ type: 'transpose', semitones });
  };

  /**
   * The loudest frequency on the way out, to a fraction of a bin.
   *
   * Three decibel readings around the peak are enough to place it inside its
   * bin: a magnitude peak in decibels is close enough to a parabola near its
   * top that fitting one is worth about an order of magnitude of resolution.
   * Only the harness calls this, and only to prove the key moved the pitch by
   * the ratio it claimed.
   */
  const dominantHz = (): number | null => {
    if (analyser === null || spectrum === null) {
      return null;
    }
    analyser.getFloatFrequencyData(spectrum);
    let loudest = Number.NEGATIVE_INFINITY;
    let at = -1;
    for (let bin = 1; bin < spectrum.length - 1; bin += 1) {
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
    return ((at + offset) * context.sampleRate) / ANALYSER_FFT;
  };

  /** How the delayed mix arrives, which is the whole of the `onReady` setting. */
  const arrival = (): { readonly seconds: number; readonly shape: FadeShape } =>
    onReady === 'continue'
      ? { seconds: CROSSFADE_SECONDS, shape: 'power-in' }
      : { seconds: FADE_IN_SECONDS, shape: 'smooth' };

  /**
   * Whether the tab's own audio should be audible. It is the only thing there
   * is to hear while priming, and only until the delayed mix takes over.
   */
  const passthroughWanted = (): boolean =>
    (passing || onReady === 'continue') && state.status !== 'live';

  /**
   * Sets the passthrough where it belongs now. Left alone once the first block
   * has fixed the moment of the crossfade, which owns this gain from then on.
   */
  const holdPassthrough = (): void => {
    if (delaySeconds !== null) {
      return;
    }
    const gain = passthrough.gain;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(passthroughWanted() ? 1 : 0, context.currentTime);
  };

  const clearPrimeTimer = (): void => {
    if (primeTimer !== null) {
      clearTimeout(primeTimer);
      primeTimer = null;
    }
  };

  const armPrimeTimer = (): void => {
    clearPrimeTimer();
    if (liveAt === null) {
      return;
    }
    primeTimer = setTimeout(
      () => {
        primeTimer = null;
        if (fillMark !== null) {
          timed('filling', since(fillMark));
        }
        reprime = null;
        moveTo({ type: 'primed' });
      },
      Math.max(0, (liveAt - context.currentTime) * 1000),
    );
  };

  /**
   * Lines the arrival of the delayed mix up with the moment its first sample
   * is due. Both halves of it are armed for that instant rather than run now:
   * the player's master gain fades up from silence, and the tab's own audio,
   * if any was being let through, fades down to meet it. `power-in` against
   * the cosine curve keeps the two at equal power across the middle, so a
   * crossfade does not dip.
   */
  const armArrival = (): void => {
    if (liveAt === null) {
      return;
    }
    const at = Math.max(context.currentTime + 0.001, liveAt);
    const fade = arrival();
    toPlayer({ type: 'master', target: 1, seconds: fade.seconds, shape: fade.shape, at });
    const gain = passthrough.gain;
    gain.cancelScheduledValues(context.currentTime);
    if (gain.value > 0) {
      gain.setValueAtTime(gain.value, context.currentTime);
      gain.setValueCurveAtTime(crossfadeOutCurve(), at, fade.seconds);
    }
  };

  /** Everything a prime starts from, whether it is the first or a later one. */
  const prime = (): void => {
    clearPrimeTimer();
    delaySeconds = null;
    liveAt = null;
    heldTotal = 0;
    heldReported = 0;
    // A reset while the page is paused stays paused. The capture is fed by the
    // page, so there is nothing to prime with until it plays again.
    heldFrom = heldFrom === null ? null : context.currentTime;
    fillMark = null;
    separateMark = null;
    listenMark = ready ? markNow() : null;
    primeMark = markNow();
    fillSeconds = 0;
    progress = null;
    clock.reset();
    // The mapping belongs to the timeline; the page's own reports do not, so
    // the media clock keeps everything it has been told.
    map.reset();
    delays = [];
    addedSeconds = 0;
    catchUpUntil = null;
    catchUpSpan = 0;
    starvedFrames = 0;
    lastUnderrun = 0;
    lateSeconds = 0;
    queuedFrames = 0;
    discarding = 0;
    toCapture({ type: 'flush' });
    toPlayer({ type: 'flush' });
    // Silent until the arrival fades it up, which is what makes the fade a
    // fade rather than a jump into the middle of a waveform.
    toPlayer({ type: 'master', target: 0, seconds: 0, shape: 'linear' });
    sendGain(0);
  };

  /**
   * Throws this timeline away and starts getting ready again.
   *
   * Called by the page for the things only the page knows — a rate change, the
   * end, an ad boundary, another video — and by this file itself when media
   * time jumps, which is the only honest evidence of a seek.
   */
  const resetTimeline = (reason: ResetReason, data: EventData | null = null): void => {
    if (!isRunning(state.status)) {
      return;
    }
    note('reset', `the timeline was thrown away: ${reason}`, data);
    prime();
    toSeparator({ type: 'reset' });
    measured = {
      ...NO_METRICS,
      reportedLagMs: measured.reportedLagMs,
      computeMs: measured.computeMs,
    };
    reprime = reason;
    holdPassthrough();
    moveTo({ type: 'reset' });
    // A reset while paused stays paused: the page is not playing, so there is
    // nothing to prime with until it does.
    tellStatus();
    tellMetrics();
  };

  /**
   * The first block of a timeline is the one that settles the delay, the
   * epoch, and the moment the arrival is lined up with.
   */
  const onFirstBlock = (first: {
    readonly startSample: number;
    readonly captureTime: number;
    readonly reportedLagMs: number;
    readonly measuredLagMs: number;
  }): number => {
    // Both numbers describe the same lag and the larger is the one that has to
    // be survived; the margin on top is a fraction of what a window costs on
    // this machine rather than a constant. It is fixed from here until either
    // a reset or the output starting to starve, which is the only thing that
    // may move it, and only upwards.
    const delay = initialDelaySeconds({
      reportedLagMs: first.reportedLagMs,
      measuredLagMs: first.measuredLagMs,
      computeMs: measured.computeMs,
    });
    delaySeconds = delay;
    const epoch = first.captureTime - first.startSample / context.sampleRate + delay;
    liveAt = epoch;
    fillMark = markNow();
    fillSeconds = Math.max(0, epoch - context.currentTime);
    if (separateMark !== null) {
      timed('separating', since(separateMark));
    }
    delays = [
      ...delays,
      { atMs: wallNowMs(), delaySeconds: delay, reason: 'first-block', addedSeconds: 0 },
    ];
    note('delay', 'the delay was chosen', {
      delaySeconds: delay,
      reportedLagMs: Math.round(first.reportedLagMs),
      measuredLagMs: Math.round(first.measuredLagMs),
      computeMs: Math.round(measured.computeMs ?? 0),
    });
    toPlayer({ type: 'epoch', epoch });
    sendGain(0);
    armArrival();
    armPrimeTimer();
    return delay;
  };

  /**
   * Grows the delay when the output is running out of separated audio, which
   * is the whole of the starvation repair.
   *
   * What this replaces was a delay fixed at the first block and defended as a
   * virtue. Four minutes into a song a window costs a second more than it did
   * at the start, the player's read head passes the frontier of finalised
   * audio, and from that moment every arriving block is for a frame already
   * read — which the ring refuses, so the output plays nothing for the rest of
   * the song and the counters climb into the millions. Growing the delay by
   * the measured shortfall plus a margin puts the head back behind the
   * frontier and lets those blocks in again.
   *
   * It is a short mute and a step backwards in the song rather than a seamless
   * repair, and there is no seamless repair: the audio that should have played
   * was never computed in time. The picture steps back with it, because what
   * the picture follows is where this output says it is.
   */
  const considerCatchUp = (): void => {
    if (delaySeconds === null || liveAt === null || stopped || held()) {
      return;
    }
    if (!isAudible(state.status)) {
      return;
    }
    if (catchUpUntil !== null) {
      if (context.currentTime < catchUpUntil) {
        // Still landing. What it starved for on the way down is not evidence
        // of needing another one.
        starvedFrames = 0;
        lateSeconds = 0;
        return;
      }
      catchUpUntil = null;
      catchUpSpan = 0;
      moveTo({ type: 'caught-up' });
    }
    const stale = context.currentTime - lateAt > SHORTFALL_MEMORY_SECONDS;
    const shortfall = shortfallSeconds({
      underrunFrames: starvedFrames,
      sampleRate: context.sampleRate,
      blockLateSeconds: stale ? 0 : lateSeconds,
      queuedFrames,
    });
    if (!needsCatchUp(shortfall)) {
      return;
    }
    const next = grownDelaySeconds({
      delaySeconds,
      shortfallSeconds: shortfall,
      computeMs: measured.computeMs,
    });
    const added = next - delaySeconds;
    starvedFrames = 0;
    lateSeconds = 0;
    if (added <= 0) {
      // Already at the cap. Nothing left to give, and saying so once per
      // timeline is more use than saying it ten times a second.
      return;
    }
    delaySeconds = next;
    addedSeconds += added;
    liveAt += added;
    catchUpSpan = added + 2 * MUTE_SECONDS;
    catchUpUntil = context.currentTime + catchUpSpan;
    delays = [
      ...delays,
      { atMs: wallNowMs(), delaySeconds: next, reason: 'catch-up', addedSeconds: added },
    ];
    note('delay', 'the delay grew to stop the output starving', {
      addedSeconds: Number(added.toFixed(3)),
      delaySeconds: next,
      shortfallSeconds: Number(shortfall.toFixed(3)),
      queuedSeconds: Number((queuedFrames / context.sampleRate).toFixed(3)),
      computeMs: Math.round(measured.computeMs ?? 0),
    });
    toPlayer({ type: 'shift', seconds: added, fadeSeconds: MUTE_SECONDS });
    moveTo({ type: 'catch-up' });
    tellStatus();
  };

  const onBlock = (event: Extract<SeparatorEvent, { type: 'block' }>): void => {
    const captureTime = clock.captureTimeOf(event.startSample);
    if (captureTime === null) {
      // A block from a timeline a reset has already thrown away.
      return;
    }
    const measuredLagMs =
      (context.currentTime - (captureTime + event.frames / context.sampleRate)) * 1000;
    measured = { ...measured, computeMs: event.computeMs };
    const delay =
      delaySeconds ??
      onFirstBlock({
        startSample: event.startSample,
        captureTime,
        reportedLagMs: event.lagMs,
        measuredLagMs,
      });

    // Past its own moment, which is the shortfall the delay has to grow by.
    const lateBySeconds = Math.max(0, context.currentTime - (captureTime + delay));
    if (lateBySeconds > 0) {
      lateSeconds = Math.max(lateSeconds, lateBySeconds);
      lateAt = context.currentTime;
    }

    if (options.onBlock !== undefined) {
      options.onBlock({
        startSample: event.startSample,
        frames: event.frames,
        captureTime,
        playTime: captureTime + delay,
        arrivedAt: context.currentTime,
        mediaSeconds: map.mediaOf(event.startSample),
        lateBySeconds,
        vocalsRms: sparseRms(event.channels[VOCALS_LEFT]),
        instrumentalRms: sparseRms(event.channels[INSTRUMENTAL_LEFT]),
      });
    }

    toPlayer(
      { type: 'block', startFrame: event.startSample, channels: event.channels },
      buffersOf(event.channels),
    );

    measured = {
      ...measured,
      measuredLagMs,
      reportedLagMs: event.lagMs,
      bufferSamples: event.bufferSamples,
      blocks: measured.blocks + 1,
    };
    considerCatchUp();
    tellMetrics();
  };

  worker.addEventListener('message', (event: MessageEvent<SeparatorEvent>) => {
    const message = event.data;
    switch (message.type) {
      case 'loading':
        pieces = { loaded: message.loaded, total: message.total };
        tellStatus();
        return;
      case 'ready':
        ready = true;
        windowSeconds = message.windowSamples / context.sampleRate;
        hopSeconds = message.hopSamples / context.sampleRate;
        timed('loading', since(primeMark));
        clock.reset();
        toCapture({ type: 'flush' });
        listenMark = markNow();
        tellStatus();
        return;
      case 'block':
        onBlock(message);
        return;
      case 'unsupported':
        // Nothing audible will ever come out of this, so stop taking the
        // tab's audio. Whatever the tab itself is doing is left alone.
        capturing = false;
        source.disconnect(capture);
        note('error', 'this machine cannot separate live', { reason: message.reason });
        moveTo({ type: 'unsupported', reason: message.reason });
        return;
      case 'failed':
        note('error', 'the separator failed', { reason: message.reason }, message.stack ?? null);
        moveTo({ type: 'error', reason: message.reason });
        return;
    }
  });

  /**
   * The wall instant a context time falls on.
   *
   * The two clocks are different clocks — one is the audio device's, one is the
   * system's — but they run at the same rate to within parts per million, so
   * one reading of each gives the offset between them, and reading both in the
   * same turn is enough. It is not exact: a chunk's stamp is the context time
   * of the quantum it began in, and capture adds a little latency before a
   * sample reaches the worklet, so the instant this returns is some tens of
   * milliseconds after the page displayed the frame it belongs with. That is
   * within a frame or two of kept picture, and it does not accumulate.
   */
  const wallMsOfContext = (contextTime: number): number =>
    wallNowMs() + (contextTime - context.currentTime) * 1000;

  /** One line per discarded stretch rather than one per chunk. */
  const endDiscarding = (): void => {
    if (discarding === 0) {
      return;
    }
    note('stall', discardingStalled ? 'the song stood still while playing' : 'the song was paused', {
      seconds: Number((discarding / context.sampleRate).toFixed(3)),
    });
    discarding = 0;
  };

  capture.port.onmessage = (event: MessageEvent<CaptureEvent>): void => {
    if (!ready || !capturing || stopped || held()) {
      // Held: the capture produces nothing while the page is paused, which is
      // what keeps the separator's timeline contiguous across one.
      return;
    }
    const chunk = event.data;
    const frames = chunk.left.length;
    const wallStart = wallMsOfContext(chunk.time);
    const verdict = map.offer({
      startSample: clock.samples,
      frames,
      span: media.span(wallStart, wallStart + (frames / context.sampleRate) * 1000),
      // With nobody reporting — a tab with no content script in it — the
      // capture's own clock is the timeline, which is what this ran on before
      // the page was ever asked.
      fallbackSeconds: chunk.time,
    });

    if (verdict.kind === 'drop') {
      // Audio the page was not moving through. Keeping it would staple a
      // stretch of silence into the middle of the song, which is what used to
      // put every frame after a buffering stall out of step with the words.
      // The clock rejoins so that the gap in context time is not read as the
      // audio thread skipping.
      clock.rejoin();
      discarding += frames;
      discardingStalled = verdict.stalled;
      return;
    }
    if (verdict.kind === 'jump') {
      endDiscarding();
      resetTimeline('seek', {
        fromSeconds: Number(verdict.fromSeconds.toFixed(3)),
        toSeconds: Number(verdict.toSeconds.toFixed(3)),
      });
      return;
    }

    endDiscarding();
    clock.stamp(chunk.time, frames);
    if (separateMark === null && clock.samples / context.sampleRate >= windowSeconds) {
      // A whole window has been heard, so the separator has something to run.
      timed('listening', windowSeconds);
      separateMark = markNow();
    }
    toSeparator(
      { type: 'chunk', startSample: verdict.startSample, left: chunk.left, right: chunk.right },
      [chunk.left.buffer as ArrayBuffer, chunk.right.buffer as ArrayBuffer],
    );
  };

  player.port.onmessage = (event: MessageEvent<PlaybackEvent>): void => {
    const playback = event.data;
    if (playback.heldSeconds !== heldReported) {
      heldReported = playback.heldSeconds;
      // The panel quotes this, so it is worth a report of its own rather than
      // waiting for the next thing to change: it only moves while the page is
      // paused, and once more when it stops being.
      tellStatus();
    }
    const starved = Math.max(0, playback.underrunFrames - lastUnderrun);
    lastUnderrun = playback.underrunFrames;
    if (starved > 0) {
      starvedFrames += starved;
      note('underrun', 'the output asked for audio nothing had written', {
        frames: starved,
        queuedFrames: playback.queuedFrames,
      });
    }
    queuedFrames = playback.queuedFrames;
    measured = {
      ...measured,
      underrunFrames: playback.underrunFrames,
      lateFrames: playback.lateFrames + playback.aheadFrames,
      gapFrames: playback.gapFrames,
      queuedFrames: playback.queuedFrames,
      // Where the output is in the song, which is the one number the picture
      // needs: the overlay paints the frame stamped with it.
      mediaSeconds: playback.playFrame < 0 ? null : map.mediaOf(playback.playFrame),
    };
    considerCatchUp();
    if (context.currentTime - driftLoggedAt >= DRIFT_LOG_SECONDS) {
      driftLoggedAt = context.currentTime;
      note('drift', 'where everything has got to', {
        driftMs: Number((clock.driftSeconds * 1000).toFixed(2)),
        queuedSeconds: Number((playback.queuedFrames / context.sampleRate).toFixed(2)),
        droppedSeconds: Number(map.droppedSeconds.toFixed(2)),
        anchors: map.anchors.length,
        computeMs: Math.round(measured.computeMs ?? 0),
        delaySeconds: delaySeconds ?? 0,
        mediaSeconds: Number((measured.mediaSeconds ?? 0).toFixed(2)),
      });
    }
    if (state.status === 'catching-up') {
      // The bar on the panel is this fraction, and it is only moving now.
      tellStatus();
    }
    if ((context.currentTime - metricsSentAt) * 1000 >= METRICS_TICK_MS - 1) {
      tellMetrics();
    }
  };

  toSeparator({
    type: 'init',
    weightsBase: options.weightsBase,
    runtimePath: options.runtimePath,
    sampleRate: context.sampleRate,
  });

  try {
    await context.resume();
  } catch (cause) {
    note('error', 'the audio context would not start', { reason: reasonText(cause) }, stackOf(cause));
    moveTo({ type: 'error', reason: reasonText(cause) });
  }
  primeMark = markNow();
  toPlayer({ type: 'master', target: 0, seconds: 0, shape: 'linear' });
  holdPassthrough();
  sendGain(0);
  sendKey();
  watchPrepare();
  tellStatus();

  return {
    sampleRate: context.sampleRate,
    status: report,
    metrics: () => measured,

    setMode(next) {
      mode = next;
      sendGain(FADE_SECONDS);
      tellStatus();
    },

    setGuide(level) {
      guide = guideLevel(level);
      sendGain(FADE_SECONDS);
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

    dominantHz,

    setPassthrough(enabled) {
      passing = enabled;
      holdPassthrough();
    },

    setOnReady(next) {
      onReady = next;
      holdPassthrough();
      tellStatus();
    },

    media(sample) {
      media.add(sample);
    },

    reset(reason) {
      resetTimeline(reason);
    },

    debug: () => ({
      atMs: wallNowMs(),
      status: state.status,
      reason: state.reason,
      sampleRate: context.sampleRate,
      delaySeconds,
      delays,
      metrics: measured,
      media: {
        anchors: map.anchors.length,
        keptSeconds: map.keptFrames / context.sampleRate,
        droppedSeconds: map.droppedSeconds,
        jumps: map.jumps,
        positionSeconds: measured.mediaSeconds,
        playing: media.newest?.playing ?? null,
        rate: media.newest?.rate ?? null,
      },
      events: log.events(),
      droppedEvents: log.dropped,
    }),

    slowSeparation(ms) {
      toSeparator({ type: 'slow', ms });
      note('note', 'the separator was asked to run slow', { ms });
    },

    hold() {
      if (held() || stopped || !isRunning(state.status)) {
        return;
      }
      // The output fades out over the mute and freezes when the fade lands, so
      // this is the instant it stops moving and the one to measure from.
      heldFrom = context.currentTime + MUTE_SECONDS;
      toPlayer({ type: 'hold', seconds: MUTE_SECONDS });
      // The partial chunk the capture is gathering is the last of the audio
      // before the pause; dropping it costs under a tenth of a second of
      // content and keeps paused silence out of the stream.
      toCapture({ type: 'flush' });
      clock.rejoin();
      endDiscarding();
      clearPrimeTimer();
      moveTo({ type: 'hold' });
    },

    resume() {
      if (!held() || stopped) {
        return;
      }
      const span = Math.max(0, context.currentTime - (heldFrom ?? context.currentTime));
      heldTotal += span;
      heldFrom = null;
      if (liveAt !== null) {
        liveAt += span;
      }
      toPlayer({ type: 'resume', seconds: MUTE_SECONDS });
      toCapture({ type: 'flush' });
      moveTo({ type: 'resume' });
      // The arrival was armed for a moment that has moved, and the prime timer
      // with it.
      if (liveAt !== null && liveAt > context.currentTime) {
        armArrival();
      }
      armPrimeTimer();
      tellStatus();
    },

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearPrimeTimer();
      watchPrepare();
      capture.port.onmessage = null;
      player.port.onmessage = null;
      toSeparator({ type: 'close' });
      for (const track of options.stream.getTracks()) {
        track.stop();
      }
      source.disconnect();
      capture.disconnect();
      player.disconnect();
      passthrough.disconnect();
      sink.disconnect();
      // The worker closes itself once its sessions are released; this is the
      // backstop for one that cannot.
      setTimeout(() => {
        worker.terminate();
      }, 2000);
      await context.close();
      moveTo({ type: 'stop' });
    },
  };
}
