import { chooseDelaySeconds, createCaptureClock } from '../audio/capture-clock.ts';
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
import { IDLE, isRunning, nextStatus, type StatusEvent, type StatusState } from '../audio/status.ts';
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
import { reasonText } from '../reason.ts';
import { DEFAULT_SETTINGS, type OnReady } from '../settings.ts';
import {
  NO_METRICS,
  type BlockStat,
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
 * says their moment has come.
 *
 * Four things are worth knowing before reading on.
 *
 * **One clock.** Everything is timed on the `AudioContext`, never on
 * `performance.now()`. A captured chunk is stamped with the context time of
 * the quantum it began in, so every sample index has a capture time, so every
 * sample has a play time: capture time plus the delay. That is also the number
 * step B delays the picture by, which is why it is one subtraction rather than
 * a guess.
 *
 * **The delay is measured, not assumed.** The separator reports what its
 * finalised audio is late by — a window, plus a hop, plus what a window costs
 * to compute on this machine. When the first block arrives the real lag is
 * measured against the capture clock, the larger of the two wins, headroom is
 * added and the result is rounded up to a half second. It then stays put until
 * a reset: a delay that twitches is worse than one slightly too long.
 *
 * **Getting ready is four stages, and it reports which one it is in.** There
 * is no countdown: loading the model, hearing the first window, separating it
 * and waiting for its moment are four different waits of four different
 * lengths, and `audio/progress.ts` maps what has measurably happened onto a
 * fraction of a bar. A seconds estimate is offered only once the stages have
 * been timed on this machine.
 *
 * **A pause is not a reset.** Pausing holds: the capture stops being fed, the
 * player freezes where it is and the epoch moves forward by however long that
 * lasted, so a resume carries on from the same sample with the same delay.
 * Only something that moves the person onto a different timeline — a real
 * seek, the end, a rate change, an ad boundary, another video — throws the
 * buffer away and primes again.
 *
 * **Capture mutes the tab.** Whatever leaves the player is the only thing the
 * person hears. So priming is silence unless passthrough is asked for, and a
 * machine that cannot separate live says so rather than playing nothing for
 * ever.
 */

/**
 * Seconds of separated audio the ring holds. A block is only ever a second or
 * two early, so this is slack rather than a requirement.
 */
const RING_SECONDS = 12;

/** Frames between sparse samples when measuring how loud a block is. */
const RMS_STEP = 64;

/**
 * How often a status report goes out while getting ready. The bar is built
 * from measurements rather than counted down from one, so it has to be
 * recomputed and sent rather than extrapolated by whoever is drawing it —
 * which is exactly what the countdown this replaced got wrong.
 */
const PREPARE_TICK_MS = 250;

export interface PipelineOptions {
  /** The tab's audio, and the only audio this extension ever touches. */
  readonly stream: MediaStream;
  readonly weightsBase: string;
  readonly runtimePath: string;
  readonly captureWorkletUrl: string;
  readonly playbackWorkletUrl: string;
  readonly mode?: PlayMode;
  readonly guide?: number;
  /** Play the tab's own audio, undelayed, while priming. Off by default. */
  readonly passthrough?: boolean;
  /** What happens at the moment the delayed audio is ready. */
  readonly onReady?: OnReady;
  readonly onStatus: (report: StatusReport) => void;
  readonly onMetrics: (metrics: Metrics) => void;
  /** Per finalised block, for the debug harness. Costs a sparse scan. */
  readonly onBlock?: (stat: BlockStat) => void;
}

export interface Pipeline {
  readonly sampleRate: number;
  status(): StatusReport;
  metrics(): Metrics;
  setMode(mode: PlayMode): void;
  setGuide(level: number): void;
  setPassthrough(enabled: boolean): void;
  setOnReady(onReady: OnReady): void;
  /** Throws away what is buffered and primes again, for a seek or an ad. */
  reset(reason: ResetReason): void;
  /** Freezes the output where it is and keeps everything, for a pause. */
  hold(): void;
  /** And carries on from the same sample, with the same delay. */
  resume(): void;
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

  const worker = new Worker(new URL('../separation/separator.worker.ts', import.meta.url), {
    type: 'module',
  });
  const clock = createCaptureClock(context.sampleRate);

  let state: StatusState = nextStatus(IDLE, { type: 'start' });
  let mode: PlayMode = options.mode ?? 'instrumental';
  let guide = guideLevel(options.guide ?? 0);
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

  const report = (): StatusReport => ({
    type: 'status',
    status: state.status,
    reason: state.reason,
    prepare: progressNow(),
    reprime,
    delaySeconds,
    heldSeconds: heldReported,
    mode,
    guide,
    onReady,
  });

  const tellStatus = (): void => {
    options.onStatus(report());
  };

  const tellMetrics = (): void => {
    measured = {
      ...measured,
      delaySeconds,
      heldSeconds: heldReported,
      driftMs: clock.driftSeconds * 1000,
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
    toCapture({ type: 'flush' });
    toPlayer({ type: 'flush' });
    // Silent until the arrival fades it up, which is what makes the fade a
    // fade rather than a jump into the middle of a waveform.
    toPlayer({ type: 'master', target: 0, seconds: 0, shape: 'linear' });
    sendGain(0);
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
    // Both numbers describe the same lag; the larger is the one that has to be
    // survived. Fixed from here until a reset.
    const delay = chooseDelaySeconds(Math.max(first.reportedLagMs, first.measuredLagMs));
    delaySeconds = delay;
    const epoch = first.captureTime - first.startSample / context.sampleRate + delay;
    liveAt = epoch;
    fillMark = markNow();
    fillSeconds = Math.max(0, epoch - context.currentTime);
    if (separateMark !== null) {
      timed('separating', since(separateMark));
    }
    toPlayer({ type: 'epoch', epoch });
    sendGain(0);
    armArrival();
    armPrimeTimer();
    return delay;
  };

  const onBlock = (event: Extract<SeparatorEvent, { type: 'block' }>): void => {
    const captureTime = clock.captureTimeOf(event.startSample);
    if (captureTime === null) {
      // A block from a timeline a reset has already thrown away.
      return;
    }
    const measuredLagMs =
      (context.currentTime - (captureTime + event.frames / context.sampleRate)) * 1000;
    const delay =
      delaySeconds ??
      onFirstBlock({
        startSample: event.startSample,
        captureTime,
        reportedLagMs: event.lagMs,
        measuredLagMs,
      });

    if (options.onBlock !== undefined) {
      options.onBlock({
        startSample: event.startSample,
        frames: event.frames,
        captureTime,
        playTime: captureTime + delay,
        arrivedAt: context.currentTime,
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
      computeMs: event.computeMs,
      bufferSamples: event.bufferSamples,
      blocks: measured.blocks + 1,
    };
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
        moveTo({ type: 'unsupported', reason: message.reason });
        return;
      case 'failed':
        moveTo({ type: 'error', reason: message.reason });
        return;
    }
  });

  capture.port.onmessage = (event: MessageEvent<CaptureEvent>): void => {
    if (!ready || !capturing || stopped || held()) {
      // Held: the capture produces nothing while the page is paused, which is
      // what keeps the separator's timeline contiguous across one.
      return;
    }
    const chunk = event.data;
    const startSample = clock.stamp(chunk.time, chunk.left.length);
    const heard = (startSample + chunk.left.length) / context.sampleRate;
    if (separateMark === null && heard >= windowSeconds) {
      // A whole window has been heard, so the separator has something to run.
      timed('listening', windowSeconds);
      separateMark = markNow();
    }
    toSeparator({ type: 'chunk', startSample, left: chunk.left, right: chunk.right }, [
      chunk.left.buffer as ArrayBuffer,
      chunk.right.buffer as ArrayBuffer,
    ]);
  };

  player.port.onmessage = (event: MessageEvent<PlaybackEvent>): void => {
    const playback = event.data;
    if (playback.heldSeconds !== heldReported) {
      heldReported = playback.heldSeconds;
      // The picture is shifted by exactly this, so it is worth a report of its
      // own rather than waiting for the next thing to change: this number only
      // moves while the page is paused, and once more when it stops being.
      tellStatus();
    }
    measured = {
      ...measured,
      underrunFrames: playback.underrunFrames,
      lateFrames: playback.lateFrames + playback.aheadFrames,
      gapFrames: playback.gapFrames,
      queuedFrames: playback.queuedFrames,
    };
    tellMetrics();
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
    moveTo({ type: 'error', reason: reasonText(cause) });
  }
  primeMark = markNow();
  toPlayer({ type: 'master', target: 0, seconds: 0, shape: 'linear' });
  holdPassthrough();
  sendGain(0);
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

    setPassthrough(enabled) {
      passing = enabled;
      holdPassthrough();
    },

    setOnReady(next) {
      onReady = next;
      holdPassthrough();
      tellStatus();
    },

    reset(reason) {
      if (!isRunning(state.status)) {
        return;
      }
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
      // A reset while paused stays paused: the page is not playing, so there
      // is nothing to prime with until it does.
      tellStatus();
      tellMetrics();
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
