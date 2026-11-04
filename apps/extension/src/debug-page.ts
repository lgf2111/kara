import type { DelayChange } from './audio/delay-plan.ts';
import type { LoggedEvent } from './audio/event-log.ts';
import type { MediaSample } from './audio/media-time.ts';
import { decidePageEvent, type PageEvent } from './content/page-events.ts';
import { prepareDetail } from './content/panel-view.ts';
import { isRealSeek, type TimelinePoint } from './content/timeline.ts';
import { startPipeline, type Pipeline } from './offscreen/pipeline.ts';
import {
  createDelayedPicture,
  type DelayedPicture,
  type PictureFace,
  type PictureState,
} from './picture/delayed-picture.ts';
import { wallNowMs } from './picture/wall-clock.ts';
import { reasonText } from './reason.ts';
import { isOnReady, type OnReady } from './settings.ts';
import type { BlockStat, Metrics, PlayMode, PrepareStage, StatusReport } from './protocol.ts';

/**
 * The audio pipeline with the extension taken away.
 *
 * Everything about tab capture needs a browser profile with an unpacked
 * extension in it, a YouTube tab, and a click on a toolbar button, none of
 * which a test can have. But none of it is the part that can be wrong. The
 * parts that can be wrong are whether the delay is what the separator said,
 * whether blocks come back in order and tile the timeline, whether the
 * instrumental actually has anything in it, whether the progress bar moves
 * forwards, whether a pause leaves the delay alone, whether the picture is on
 * the frame the audio is playing, and whether any of that survives a page
 * that stalls, lies about seeking or starts paused. All of them only need a
 * video and a stream.
 *
 * So this page plays a local fixture in a `<video>`, takes
 * `video.captureStream()` as the pipeline's input, and puts the status, the
 * metrics and every block on `window.__karaDebug` for Playwright to read.
 * `startPipeline` is the same function the offscreen document calls, with the
 * same worklets and the same worker: the only difference is where the stream
 * came from and that `chrome.runtime.getURL` is a path on the preview server.
 *
 * The same argument applies to the picture, the page events and — new, and the
 * reason this file grew — **the page's own clock**. The content script's whole
 * job in the running extension is to report where the page is in the song, and
 * this page does exactly that, at the same four times a second, from the
 * fixture. Which means the four failures that only happen on real YouTube can
 * be made to happen here on purpose:
 *
 * - {@link KaraDebug.simulateStall} holds media time still while the capture
 *   keeps running, which is what buffering does and what used to staple
 *   silence into the middle of the song.
 * - {@link KaraDebug.simulateSeekEvent} fires `seeking` without moving
 *   anything, which is what buffering and a quality change do, and which used
 *   to cost the entire delay.
 * - {@link KaraDebug.startPaused} starts on a paused video, which used to
 *   separate silence and start the timeline on it.
 * - {@link KaraDebug.slowSeparation} makes every window cost more than it
 *   should, which is what a warm GPU does four minutes into a song, and which
 *   used to end in silence for the rest of the song.
 */

/** The pattern fixture: the tones, with a timestamped picture over them. */
const DEFAULT_FIXTURE = '/fixtures/pattern-240s.mp4';
const WEIGHTS_BASE = '/weights/htdemucs-web';
const RUNTIME_PATH = '/ort/';
const CAPTURE_WORKLET = '/capture-worklet.js';
const PLAYBACK_WORKLET = '/playback-worklet.js';

/** Blocks kept, which is more than any assertion needs. */
const BLOCK_HISTORY = 64;

/** Progress samples kept: at four a second, five minutes of them. */
const PROGRESS_HISTORY = 1200;

/** How often the page tells the audio side where it is, as in the extension. */
const MEDIA_TICK_MS = 250;

/** Picture-to-audio offsets kept, for a run's worth of them. */
const OFFSET_HISTORY = 600;

export interface ProgressSample {
  readonly atMs: number;
  readonly stage: PrepareStage;
  readonly fraction: number;
}

export interface ProgressTrace {
  readonly samples: readonly ProgressSample[];
  /** Whether the bar ever went backwards, which it must not. */
  readonly monotonic: boolean;
  readonly max: number;
  /** Whether it got all the way to audible. */
  readonly live: boolean;
}

/** How far the picture is from the audio, and what it is measured against. */
export interface OffsetTrace {
  /** Where in the song the audio says it is. */
  readonly audioSeconds: number | null;
  /** Where in the song the frame on the canvas is from. */
  readonly paintedSeconds: number | null;
  /** The difference, which is the number worth asserting on. */
  readonly offsetSeconds: number | null;
  /**
   * Seconds of simulated stall, which the fixture's own frames know nothing
   * about: a real stall holds the page's clock still, and this page can only
   * hold the *reported* clock still. Add it back before comparing a painted
   * frame's stamp with anything the fixture itself did.
   */
  readonly simulatedStallSeconds: number;
  readonly samples: readonly number[];
  /** The largest the offset has been, absolute, since the last start. */
  readonly worstSeconds: number;
  /** Times the picture had to step rather than ease, which a catch-up does. */
  readonly snaps: number;
}

/** What eighteen seconds of picture is actually costing. */
export interface FrameMemory {
  readonly frames: number;
  readonly bytes: number;
  readonly megabytes: number;
  /** Frames dropped because the budget was spent. */
  readonly dropped: number;
  /** Decoded frames held, which is the only GPU memory the picture costs. */
  readonly decoded: number;
}

export interface KaraDebug {
  status: () => StatusReport | null;
  metrics: () => Metrics | null;
  blocks: () => readonly BlockStat[];
  failure: () => string | null;
  /** Frames held, what they cost, which one is painted, and how late it is. */
  picture: () => PictureState | null;
  /**
   * Seconds between where the picture is and where the audio is, in the song.
   * Negative by up to one frame interval is correct: a frame is painted from
   * at or before the moment asked for, never after. Null until both halves
   * have something to say.
   */
  pictureOffsetSeconds: () => number | null;
  /** The same, with everything it was measured against. */
  offsets: () => OffsetTrace;
  /** Every fraction the bar has been at, and whether it only went forwards. */
  progress: () => ProgressTrace;
  /**
   * How many times it has started getting ready again after being audible. A
   * pause, a play, a buffering stall and a `seeking` event that moved nothing
   * must not add to this; a real seek must.
   */
  primes: () => number;
  /** Every delay it has settled on. A pause must not add to this either. */
  delays: () => readonly number[];
  /** And every change of delay with its reason, which is the catch-up trace. */
  delayHistory: () => readonly DelayChange[];
  /** Frames the output asked for that nothing had written. */
  underruns: () => number;
  /** What the frame store is holding and what it costs. */
  frameMemory: () => FrameMemory;
  /** The ring the popup's copy button copies. */
  events: () => readonly LoggedEvent[];
  /** Seconds of capture discarded because the song was not moving. */
  droppedSeconds: () => number;
  start: (fixture?: string) => Promise<void>;
  /**
   * Starts without playing, which is the one case that used to separate
   * silence and start the timeline on it. Nothing should prime, the panel
   * should ask for a press of play, and `status()` should say so.
   */
  startPaused: (fixture?: string) => Promise<void>;
  setMode: (mode: PlayMode) => void;
  setGuide: (level: number) => void;
  /** The key, in semitones, which the player applies last of all. */
  setTranspose: (semitones: number) => void;
  /**
   * The loudest frequency coming out of the player, off an `AnalyserNode` on
   * its output, or null before there is anything above the noise floor.
   */
  dominantHz: () => number | null;
  setOnReady: (onReady: OnReady) => void;
  /** Seconds along the fixture, for testing what a seek does to both halves. */
  seek: (seconds: number) => void;
  /** The fixture's own pause and play, through the same table the page uses. */
  pause: () => void;
  play: () => Promise<void>;
  /**
   * Holds the reported media time still for this long while the capture keeps
   * running, which is what a YouTube buffering stall does. The audio captured
   * through it must be discarded rather than separated, and nothing must
   * reset.
   */
  simulateStall: (ms: number) => void;
  /**
   * Fires a `seeking` event without moving anything, which is what buffering,
   * a quality change and adopting a new source all do. Nothing must reset.
   */
  simulateSeekEvent: () => void;
  /**
   * Adds this many milliseconds to every window's compute, which is how a
   * four-minute run on a warm GPU is reproduced in one minute on a cold one.
   */
  slowSeparation: (ms: number) => void;
  reset: () => void;
  stop: () => Promise<void>;
}

declare global {
  interface Window {
    __karaDebug?: KaraDebug;
  }
}

/** A media element that can hand its own output over as a stream. */
interface Capturable {
  captureStream?: () => MediaStream;
}

function need<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`the debug page has no ${selector}`);
  }
  return found;
}

const video = need<HTMLVideoElement>('#video');
const stage = need<HTMLDivElement>('#stage');
const statusLine = need<HTMLParagraphElement>('#status');
const metricsBlock = need<HTMLPreElement>('#metrics');

const asked = new URLSearchParams(location.search);
const wantedOnReady = asked.get('onReady');

let pipeline: Pipeline | null = null;
let picture: DelayedPicture | null = null;
let status: StatusReport | null = null;
let metrics: Metrics | null = null;
let failure: string | null = null;
let onReady: OnReady = isOnReady(wantedOnReady) ? wantedOnReady : 'restart';
const blocks: BlockStat[] = [];

const progressSamples: ProgressSample[] = [];
let monotonic = true;
let maxFraction = 0;
let primes = 0;
const delays: number[] = [];
const offsetSamples: number[] = [];
let worstOffset = 0;

/** Where the fixture's clock was, so a real seek can be told from playing. */
let lastPoint: TimelinePoint | null = null;
let seeking = false;
let anchored = false;
let mediaTicker: ReturnType<typeof setInterval> | null = null;

/**
 * A simulated buffering stall: the wall instant it ends at, where media time
 * is standing still, and how much of the song has been stood through.
 *
 * A real stall holds the page's own clock still, which this page cannot do to
 * a fixture that is playing. What it can do is hold the clock it *reports*
 * still, which is the clock the audio side actually reasons about, so every
 * decision under test sees exactly what it would see. The difference is that
 * the fixture's own frames carry on being stamped with its real time, so
 * `simulatedStallSeconds` is the offset to add back before comparing them.
 */
let stallUntilMs: number | null = null;
let stallAtSeconds = 0;
let stallOffsetSeconds = 0;

function point(): TimelinePoint {
  return {
    mediaSeconds: video.currentTime,
    wallMs: performance.now(),
    rate: video.playbackRate,
    paused: video.paused,
  };
}

/** Where the page says it is in the song, stall and all. */
function reportedMediaSeconds(): number {
  const running = video.currentTime - stallOffsetSeconds;
  if (stallUntilMs === null) {
    return running;
  }
  if (wallNowMs() < stallUntilMs) {
    return stallAtSeconds;
  }
  // The stall is over, and the song carries on from where it stood still —
  // which is what makes the stretch in between capture with nowhere to go.
  stallOffsetSeconds += running - stallAtSeconds;
  stallUntilMs = null;
  return stallAtSeconds;
}

function mediaSample(): MediaSample {
  const stalling = stallUntilMs !== null && wallNowMs() < stallUntilMs;
  return {
    wallMs: wallNowMs(),
    mediaSeconds: reportedMediaSeconds(),
    // A stalling page says it is playing, which is the whole difficulty: the
    // only evidence that it is not is that its clock is not moving.
    playing: stalling || (!video.paused && !video.ended && video.readyState >= 3),
    rate: video.playbackRate,
  };
}

function tellMedia(): void {
  pipeline?.media(mediaSample());
}

/**
 * How far the picture is from the audio, in the song. Both halves name the
 * same place now — the audio reports where its output has reached and the
 * overlay paints the frame stamped with it — so this is a difference of two
 * media times rather than a difference of two clocks.
 */
function pictureOffsetSeconds(): number | null {
  return picture?.state().offsetSeconds ?? null;
}

function faceWanted(): PictureFace | null {
  if (status === null || status.status === 'idle') {
    return null;
  }
  if (status.status === 'live' || status.status === 'catching-up') {
    return 'live';
  }
  if (status.status === 'unsupported' || status.status === 'error') {
    return null;
  }
  return status.onReady === 'continue' ? 'hidden' : 'dimmed';
}

function draw(): void {
  const prepare = status?.prepare ?? null;
  statusLine.textContent = [
    status?.status ?? 'idle',
    prepare === null ? null : `${String(Math.round(prepare.fraction * 100))}%`,
    status === null ? null : prepareDetail(status),
    status?.waitingForPlay === true ? 'press play to begin' : null,
    status?.reason,
    failure === null ? null : `failed: ${failure}`,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ');
  metricsBlock.textContent = JSON.stringify(
    {
      metrics,
      semitones: status?.semitones ?? 0,
      catchUp: status?.catchUp ?? null,
      dominantHz: pipeline?.dominantHz() ?? null,
      picture: picture?.state() ?? null,
      pictureOffsetSeconds: pictureOffsetSeconds(),
      frameMemory: frameMemory(),
      progress: { monotonic, max: maxFraction, samples: progressSamples.length },
      primes,
      delays,
      blocks: blocks.slice(-3),
    },
    null,
    2,
  );
}

function frameMemory(): FrameMemory {
  const state = picture?.state() ?? null;
  const bytes = state?.bytes ?? 0;
  return {
    frames: state?.frames ?? 0,
    bytes,
    megabytes: Number((bytes / 1024 / 1024).toFixed(2)),
    dropped: state?.dropped ?? 0,
    decoded: state?.decoded ?? 0,
  };
}

/** Everything the content script does with a report, minus the panel. */
function onStatus(next: StatusReport): void {
  const was = status;
  status = next;
  onReady = next.onReady;

  const prepare = next.prepare;
  if (prepare !== null) {
    if (prepare.fraction < maxFraction - 1e-9) {
      monotonic = false;
    }
    maxFraction = Math.max(maxFraction, prepare.fraction);
    progressSamples.push({
      atMs: performance.now(),
      stage: prepare.stage,
      fraction: prepare.fraction,
    });
    if (progressSamples.length > PROGRESS_HISTORY) {
      progressSamples.shift();
    }
  }
  if (
    next.status === 'priming' &&
    (was?.status === 'live' || was?.status === 'catching-up' || was?.status === 'paused')
  ) {
    // Getting ready again after having been audible, which only a real seek,
    // a rate change, an ad, the end or another video should ever cause.
    primes += 1;
    maxFraction = 0;
  }
  if (next.delaySeconds !== null && !delays.includes(next.delaySeconds)) {
    delays.push(next.delaySeconds);
  }

  const face = faceWanted();
  if (picture !== null) {
    if (face === null) {
      picture.clear();
      anchored = false;
    } else {
      picture.setPreparing(
        prepare === null
          ? null
          : { fraction: prepare.fraction, label: prepareDetail(next) ?? 'Preparing' },
      );
      if (!anchored && prepare !== null && prepare.stage !== 'loading') {
        picture.anchor();
        anchored = true;
      }
      if (!picture.state().active) {
        picture.start(face);
      } else if (next.status !== 'paused') {
        picture.setFace(face);
      }
    }
  }
  draw();
}

/** The one number the picture is driven by, ten times a second. */
function onMetrics(next: Metrics): void {
  metrics = next;
  picture?.setRate(video.playbackRate);
  picture?.setPosition(next.mediaSeconds);
  const offset = pictureOffsetSeconds();
  if (offset !== null) {
    offsetSamples.push(Number(offset.toFixed(4)));
    if (offsetSamples.length > OFFSET_HISTORY) {
      offsetSamples.shift();
    }
    worstOffset = Math.max(worstOffset, Math.abs(offset));
  }
  draw();
}

/** The same table the content script reads, against the same judgement. */
function apply(event: PageEvent): void {
  const decision = decidePageEvent(event);
  switch (decision.audio) {
    case 'reset':
      if (decision.reset !== null) {
        pipeline?.reset(decision.reset);
      }
      anchored = false;
      break;
    case 'hold':
      pipeline?.hold();
      break;
    case 'resume':
      pipeline?.resume();
      break;
    case 'none':
      break;
  }
  tellMedia();
  if (decision.passthrough !== null) {
    pipeline?.setPassthrough(decision.passthrough);
  }
  switch (decision.picture) {
    case 'freeze':
      picture?.freeze();
      return;
    case 'thaw':
      picture?.thaw();
      return;
    case 'clear':
      picture?.clear();
      return;
    case 'reprime':
      picture?.clear();
      picture?.start(faceWanted() ?? 'dimmed');
      return;
    case 'none':
      return;
  }
}

for (const event of ['seeking', 'seeked', 'pause', 'play', 'ratechange', 'ended'] as const) {
  video.addEventListener(event, () => {
    if (event === 'seeking') {
      seeking = isRealSeek(lastPoint, point());
      if (seeking) {
        apply(event);
      }
    } else if (event === 'seeked') {
      if (seeking) {
        apply(event);
      }
      seeking = false;
    } else {
      apply(event);
    }
    lastPoint = point();
  });
}
video.addEventListener('timeupdate', () => {
  lastPoint = point();
});

interface StartOptions {
  readonly fixture?: string;
  /** Start without playing, which is the paused-start case. */
  readonly paused?: boolean;
}

async function start(options: StartOptions = {}): Promise<void> {
  const fixture = options.fixture ?? DEFAULT_FIXTURE;
  await stop();
  failure = null;
  blocks.length = 0;
  progressSamples.length = 0;
  delays.length = 0;
  offsetSamples.length = 0;
  worstOffset = 0;
  monotonic = true;
  maxFraction = 0;
  primes = 0;
  anchored = false;
  stallUntilMs = null;
  stallOffsetSeconds = 0;
  video.src = fixture;
  // Deliberately not muted: `captureStream` on a muted element is not a thing
  // to rely on, and hearing the fixture undelayed next to the delayed output
  // is the cheapest way for a person to check the delay by ear.
  //
  // A paused start still plays for an instant, because an element that has
  // never played has no stream to capture. The capture that comes of it is a
  // fraction of a chunk and the song does not move through it, so the pipeline
  // discards it — which is the behaviour under test.
  await video.play();
  if (options.paused === true) {
    video.pause();
  }
  lastPoint = point();

  const capture = (video as unknown as Capturable).captureStream;
  if (capture === undefined) {
    throw new Error('this browser cannot capture a media element');
  }
  const stream = capture.call(video);
  if (stream.getAudioTracks().length === 0) {
    throw new Error(`${fixture} gave no audio track`);
  }

  // Up before the first block arrives, because the frame the picture will
  // want in eighteen seconds is the one on screen now.
  picture ??= createDelayedPicture({ video, container: stage });
  picture.start(onReady === 'continue' ? 'hidden' : 'dimmed');

  pipeline = await startPipeline({
    stream,
    weightsBase: WEIGHTS_BASE,
    runtimePath: RUNTIME_PATH,
    captureWorkletUrl: CAPTURE_WORKLET,
    playbackWorkletUrl: PLAYBACK_WORKLET,
    onReady,
    // So `dominantHz` has something to read. The packed extension never asks.
    analyse: true,
    onStatus,
    onMetrics,
    onBlock: (stat) => {
      blocks.push(stat);
      if (blocks.length > BLOCK_HISTORY) {
        blocks.shift();
      }
    },
  });
  // The same four a second the content script sends, because the audio side
  // decides what to keep from these and nothing else.
  tellMedia();
  mediaTicker = setInterval(tellMedia, MEDIA_TICK_MS);
  if (options.paused === true) {
    pipeline.hold();
  }
}

async function stop(): Promise<void> {
  const running = pipeline;
  pipeline = null;
  if (mediaTicker !== null) {
    clearInterval(mediaTicker);
    mediaTicker = null;
  }
  picture?.clear();
  if (running !== null) {
    await running.stop();
  }
  video.pause();
}

function report(cause: unknown): void {
  failure = reasonText(cause);
  draw();
}

function seek(seconds: number): void {
  video.currentTime = Math.max(0, seconds);
}

need<HTMLButtonElement>('#start').addEventListener('click', () => {
  start().catch(report);
});

need<HTMLButtonElement>('#mode').addEventListener('click', () => {
  pipeline?.setMode(status?.mode === 'original' ? 'instrumental' : 'original');
});

need<HTMLButtonElement>('#reset').addEventListener('click', () => {
  // What a seek does, without moving the fixture.
  pipeline?.reset('seek');
  picture?.clear();
  picture?.start(faceWanted() ?? 'dimmed');
});

need<HTMLButtonElement>('#seek').addEventListener('click', () => {
  seek(video.currentTime + 30);
});

need<HTMLButtonElement>('#key-down').addEventListener('click', () => {
  pipeline?.setKey((status?.semitones ?? 0) - 1);
});

need<HTMLButtonElement>('#key-up').addEventListener('click', () => {
  pipeline?.setKey((status?.semitones ?? 0) + 1);
});

need<HTMLButtonElement>('#hold').addEventListener('click', () => {
  if (video.paused) {
    void video.play();
    return;
  }
  video.pause();
});

need<HTMLButtonElement>('#stall').addEventListener('click', () => {
  simulateStall(3000);
});

need<HTMLButtonElement>('#slow').addEventListener('click', () => {
  slowSeparation(2000);
});

need<HTMLButtonElement>('#picture').addEventListener('click', () => {
  if (picture?.state().active === true) {
    picture.clear();
  } else {
    picture ??= createDelayedPicture({ video, container: stage });
    picture.start(faceWanted() ?? 'dimmed');
  }
  draw();
});

need<HTMLButtonElement>('#stop').addEventListener('click', () => {
  stop().catch(report);
});

function simulateStall(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  stallAtSeconds = video.currentTime - stallOffsetSeconds;
  stallUntilMs = wallNowMs() + ms;
  tellMedia();
}

function slowSeparation(ms: number): void {
  pipeline?.slowSeparation(ms);
}

window.__karaDebug = {
  status: () => status,
  metrics: () => metrics,
  blocks: () => blocks,
  failure: () => failure,
  picture: () => picture?.state() ?? null,
  pictureOffsetSeconds,
  offsets: () => {
    const state = picture?.state() ?? null;
    return {
      audioSeconds: state?.positionSeconds ?? null,
      paintedSeconds: state?.paintedSeconds ?? null,
      offsetSeconds: state?.offsetSeconds ?? null,
      simulatedStallSeconds: stallOffsetSeconds,
      samples: offsetSamples,
      worstSeconds: worstOffset,
      snaps: state?.snaps ?? 0,
    };
  },
  progress: () => ({
    samples: progressSamples,
    monotonic,
    max: maxFraction,
    live: status?.status === 'live' || status?.status === 'catching-up',
  }),
  primes: () => primes,
  delays: () => delays,
  delayHistory: () => pipeline?.debug().delays ?? [],
  underruns: () => metrics?.underrunFrames ?? 0,
  frameMemory,
  events: () => pipeline?.debug().events ?? [],
  droppedSeconds: () => metrics?.droppedSeconds ?? 0,
  start: async (fixture) => {
    await start(fixture === undefined ? {} : { fixture }).catch(report);
  },
  startPaused: async (fixture) => {
    await start(fixture === undefined ? { paused: true } : { fixture, paused: true }).catch(report);
  },
  setMode: (mode) => {
    pipeline?.setMode(mode);
  },
  setGuide: (level) => {
    pipeline?.setGuide(level);
  },
  setTranspose: (semitones) => {
    pipeline?.setKey(semitones);
  },
  dominantHz: () => pipeline?.dominantHz() ?? null,
  setOnReady: (next) => {
    onReady = next;
    pipeline?.setOnReady(next);
  },
  seek,
  pause: () => {
    video.pause();
  },
  play: async () => {
    await video.play();
  },
  simulateStall,
  simulateSeekEvent: () => {
    // No movement, no change of state: exactly what the page fires while it
    // is buffering, adopting a new source or changing quality.
    video.dispatchEvent(new Event('seeking'));
  },
  slowSeparation,
  reset: () => {
    pipeline?.reset('seek');
  },
  stop,
};

// The overlay paints on its own animation frames; this is only so a person
// watching the page sees the numbers move with it.
setInterval(draw, 500);

if (asked.get('autoplay') === '1') {
  // Chrome needs --autoplay-policy=no-user-gesture-required for this, which is
  // a flag a test runner can pass and a person can click past instead.
  const fixture = asked.get('fixture') ?? DEFAULT_FIXTURE;
  const paused = asked.get('paused') === '1';
  start({ fixture, paused }).catch(report);
}
draw();
