import { chooseDelaySeconds, createCaptureClock } from '../audio/capture-clock.ts';
import { FADE_SECONDS, guideLevel, vocalGainFor, type PlayMode } from '../audio/mix-gain.ts';
import {
  IDLE,
  nextStatus,
  primingSecondsLeft,
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
import { reasonText } from '../reason.ts';
import { NO_METRICS, type BlockStat, type Metrics, type StatusReport } from '../protocol.ts';

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
 * Three things are worth knowing before reading on.
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
  /** Throws away what is buffered and primes again, for a seek or a pause. */
  reset(): void;
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
  let primingFrom = performance.now();
  let primeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Null until the first block has been measured. */
  let delaySeconds: number | null = null;
  /** What the separator expected, for the countdown before any block. */
  let plannedDelay: number | null = null;
  let measured: Metrics = NO_METRICS;
  /**
   * Chunks are dropped until the model is loaded, and the clock is restarted
   * when it is. Twenty-one graph pieces take a while to compile, and audio
   * captured in the meantime would put the separator's sample zero somewhere
   * the clock had already passed, which would make every measurement wrong.
   */
  let ready = false;
  let capturing = true;
  let stopped = false;

  const report = (): StatusReport => ({
    type: 'status',
    status: state.status,
    reason: state.reason,
    secondsLeft:
      state.status === 'priming'
        ? primingSecondsLeft(primingFrom, performance.now(), delaySeconds ?? plannedDelay ?? 0)
        : null,
    delaySeconds,
    mode,
    guide,
  });

  const tellStatus = (): void => {
    options.onStatus(report());
  };

  const tellMetrics = (): void => {
    measured = { ...measured, delaySeconds, driftMs: clock.driftSeconds * 1000 };
    options.onMetrics(measured);
  };

  const moveTo = (event: StatusEvent): void => {
    const next = nextStatus(state, event);
    if (next !== state) {
      state = next;
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

  /** Passthrough is the tab's own audio, so it only plays while priming. */
  const holdPassthrough = (): void => {
    const gain = passthrough.gain;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(passing && delaySeconds === null ? 1 : 0, context.currentTime);
  };

  const clearPrimeTimer = (): void => {
    if (primeTimer !== null) {
      clearTimeout(primeTimer);
      primeTimer = null;
    }
  };

  /**
   * The moment the first delayed sample is due. Any passthrough is faded out
   * to land exactly there, so the undelayed and the delayed never overlap.
   */
  const goLiveAt = (epoch: number): void => {
    const gain = passthrough.gain;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(gain.value, context.currentTime);
    gain.linearRampToValueAtTime(0, Math.max(context.currentTime + 0.001, epoch));
    clearPrimeTimer();
    primeTimer = setTimeout(
      () => {
        primeTimer = null;
        moveTo({ type: 'primed' });
      },
      Math.max(0, (epoch - context.currentTime) * 1000),
    );
  };

  const onBlock = (event: Extract<SeparatorEvent, { type: 'block' }>): void => {
    const captureTime = clock.captureTimeOf(event.startSample);
    if (captureTime === null) {
      // A block from a timeline a reset has already thrown away.
      return;
    }
    const measuredLagMs =
      (context.currentTime - (captureTime + event.frames / context.sampleRate)) * 1000;

    let delay = delaySeconds;
    if (delay === null) {
      // Both numbers describe the same lag; the larger is the one that has to
      // be survived. Fixed from here until a reset.
      delay = chooseDelaySeconds(Math.max(event.lagMs, measuredLagMs));
      delaySeconds = delay;
      const epoch = captureTime - event.startSample / context.sampleRate + delay;
      toPlayer({ type: 'epoch', epoch });
      sendGain(0);
      goLiveAt(epoch);
    }

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
        state = {
          status: state.status,
          reason: `loading the model, ${String(message.loaded)} of ${String(message.total)}`,
        };
        tellStatus();
        return;
      case 'ready':
        ready = true;
        plannedDelay = chooseDelaySeconds(message.lagMs);
        clock.reset();
        toCapture({ type: 'flush' });
        primingFrom = performance.now();
        state = { status: state.status, reason: null };
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
    if (!ready || !capturing || stopped) {
      return;
    }
    const chunk = event.data;
    const startSample = clock.stamp(chunk.time, chunk.left.length);
    toSeparator({ type: 'chunk', startSample, left: chunk.left, right: chunk.right }, [
      chunk.left.buffer as ArrayBuffer,
      chunk.right.buffer as ArrayBuffer,
    ]);
  };

  player.port.onmessage = (event: MessageEvent<PlaybackEvent>): void => {
    const playback = event.data;
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
  holdPassthrough();
  sendGain(0);
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

    reset() {
      clearPrimeTimer();
      delaySeconds = null;
      clock.reset();
      measured = {
        ...NO_METRICS,
        reportedLagMs: measured.reportedLagMs,
        computeMs: measured.computeMs,
      };
      toCapture({ type: 'flush' });
      toPlayer({ type: 'flush' });
      toSeparator({ type: 'reset' });
      primingFrom = performance.now();
      holdPassthrough();
      moveTo({ type: 'reset' });
      tellMetrics();
    },

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearPrimeTimer();
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
