import { decidePageEvent, type PageEvent } from './content/page-events.ts';
import { prepareDetail } from './content/panel-view.ts';
import { isRealSeek, type TimelinePoint } from './content/timeline.ts';
import { startPipeline, type Pipeline } from './offscreen/pipeline.ts';
import {
  createDelayedPicture,
  DEFAULT_DELAY_SECONDS,
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
 * forwards, whether a pause leaves the delay alone, and whether the key
 * control moves the pitch by the ratio it claims. All of them only need a
 * video and a stream.
 *
 * So this page plays a local fixture in a `<video>`, takes
 * `video.captureStream()` as the pipeline's input, and puts the status, the
 * metrics and every block on `window.__karaDebug` for Playwright to read.
 * `startPipeline` is the same function the offscreen document calls, with the
 * same worklets and the same worker: the only difference is where the stream
 * came from and that `chrome.runtime.getURL` is a path on the preview server.
 *
 * The same argument applies to the picture and to the page events. The
 * overlay here is the same `delayed-picture.ts` the content script draws, over
 * the fixture instead of over YouTube, and the fixture's own `pause`, `play`
 * and `seeking` events go through the same `page-events.ts` table and the same
 * `timeline.ts` judgement the content script uses. That is what makes the two
 * UX promises testable without a browser profile: that a pause and a play keep
 * the same delay and never prime again, and that a real seek does.
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

export interface KaraDebug {
  status: () => StatusReport | null;
  metrics: () => Metrics | null;
  blocks: () => readonly BlockStat[];
  failure: () => string | null;
  /** Frames held, what they cost, which one is painted, and how late it is. */
  picture: () => PictureState | null;
  /**
   * Seconds between where the picture is and where the audio is. The fixture
   * plays undelayed, so the audio is `delaySeconds` behind it and the painted
   * frame is however far behind it the overlay has managed; the difference is
   * this. Positive means the picture is later than the sound. Null until both
   * a frame has been painted and a delay has been settled on.
   */
  pictureOffsetSeconds: () => number | null;
  /** Every fraction the bar has been at, and whether it only went forwards. */
  progress: () => ProgressTrace;
  /**
   * How many times it has started getting ready again after being audible. A
   * pause and a play must not add to this; a seek must.
   */
  primes: () => number;
  /** Every delay it has settled on. A pause must not add to this either. */
  delays: () => readonly number[];
  start: (fixture?: string) => Promise<void>;
  setMode: (mode: PlayMode) => void;
  setGuide: (level: number) => void;
  /** The key, in semitones, which the player applies last of all. */
  setTranspose: (semitones: number) => void;
  /**
   * The loudest frequency coming out of the player, off an `AnalyserNode` on
   * its output, or null before there is anything above the noise floor.
   *
   * The one number that can prove the key control did what it said: play the
   * tone fixture, read this, transpose, read it again, and the ratio of the
   * two is `2 ** (semitones / 12)` or the shifter is wrong.
   */
  dominantHz: () => number | null;
  setOnReady: (onReady: OnReady) => void;
  /** Seconds along the fixture, for testing what a seek does to both halves. */
  seek: (seconds: number) => void;
  /** The fixture's own pause and play, through the same table the page uses. */
  pause: () => void;
  play: () => Promise<void>;
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

/** Where the fixture's clock was, so a real seek can be told from playing. */
let lastPoint: TimelinePoint | null = null;
let seeking = false;
let anchored = false;

function point(): TimelinePoint {
  return {
    mediaSeconds: video.currentTime,
    wallMs: performance.now(),
    rate: video.playbackRate,
    paused: video.paused,
  };
}

/**
 * How far the picture is behind the audio, in seconds, or null while either
 * half has nothing to say. Measured against the delay the audio settled on
 * rather than the one the overlay was asked for, so a picture aiming at the
 * wrong number shows up here rather than cancelling itself out.
 */
function pictureOffsetSeconds(): number | null {
  const state = picture?.state() ?? null;
  const delay = status?.delaySeconds ?? null;
  if (state === null || state.paintedStampMs === null || delay === null) {
    return null;
  }
  return (wallNowMs() - state.paintedStampMs) / 1000 - (delay + state.heldSeconds);
}

function faceWanted(): PictureFace | null {
  if (status === null || status.status === 'idle') {
    return null;
  }
  if (status.status === 'live') {
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
    status?.reason,
    failure === null ? null : `failed: ${failure}`,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ');
  metricsBlock.textContent = JSON.stringify(
    {
      metrics,
      semitones: status?.semitones ?? 0,
      dominantHz: pipeline?.dominantHz() ?? null,
      picture: picture?.state() ?? null,
      pictureOffsetSeconds: pictureOffsetSeconds(),
      progress: { monotonic, max: maxFraction, samples: progressSamples.length },
      primes,
      delays,
      blocks: blocks.slice(-3),
    },
    null,
    2,
  );
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
  if (next.status === 'priming' && (was?.status === 'live' || was?.status === 'paused')) {
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
      picture.setDelay(next.delaySeconds ?? DEFAULT_DELAY_SECONDS);
      picture.setHeld(next.heldSeconds);
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
        picture.start(next.delaySeconds ?? DEFAULT_DELAY_SECONDS, face);
      } else if (next.status !== 'paused') {
        picture.setFace(face);
      }
    }
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
      picture?.start(status?.delaySeconds ?? DEFAULT_DELAY_SECONDS, faceWanted() ?? 'dimmed');
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

async function start(fixture = DEFAULT_FIXTURE): Promise<void> {
  await stop();
  failure = null;
  blocks.length = 0;
  progressSamples.length = 0;
  delays.length = 0;
  monotonic = true;
  maxFraction = 0;
  primes = 0;
  anchored = false;
  video.src = fixture;
  // Deliberately not muted: `captureStream` on a muted element is not a thing
  // to rely on, and hearing the fixture undelayed next to the delayed output
  // is the cheapest way for a person to check the delay by ear.
  await video.play();
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
  picture.start(DEFAULT_DELAY_SECONDS, onReady === 'continue' ? 'hidden' : 'dimmed');

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
    onMetrics: (next) => {
      metrics = next;
      draw();
    },
    onBlock: (stat) => {
      blocks.push(stat);
      if (blocks.length > BLOCK_HISTORY) {
        blocks.shift();
      }
    },
  });
}

async function stop(): Promise<void> {
  const running = pipeline;
  pipeline = null;
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
  picture?.start(status?.delaySeconds ?? DEFAULT_DELAY_SECONDS, faceWanted() ?? 'dimmed');
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

need<HTMLButtonElement>('#picture').addEventListener('click', () => {
  if (picture?.state().active === true) {
    picture.clear();
  } else {
    picture ??= createDelayedPicture({ video, container: stage });
    picture.start(status?.delaySeconds ?? DEFAULT_DELAY_SECONDS, faceWanted() ?? 'dimmed');
  }
  draw();
});

need<HTMLButtonElement>('#stop').addEventListener('click', () => {
  stop().catch(report);
});

window.__karaDebug = {
  status: () => status,
  metrics: () => metrics,
  blocks: () => blocks,
  failure: () => failure,
  picture: () => picture?.state() ?? null,
  pictureOffsetSeconds,
  progress: () => ({
    samples: progressSamples,
    monotonic,
    max: maxFraction,
    live: status?.status === 'live',
  }),
  primes: () => primes,
  delays: () => delays,
  start: async (fixture) => {
    await start(fixture).catch(report);
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
  start(asked.get('fixture') ?? DEFAULT_FIXTURE).catch(report);
}
draw();
