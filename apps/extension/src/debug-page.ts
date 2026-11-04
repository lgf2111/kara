import { startPipeline, type Pipeline } from './offscreen/pipeline.ts';
import {
  createDelayedPicture,
  DEFAULT_DELAY_SECONDS,
  type DelayedPicture,
  type PictureState,
} from './picture/delayed-picture.ts';
import { wallNowMs } from './picture/wall-clock.ts';
import { reasonText } from './reason.ts';
import type { BlockStat, Metrics, PlayMode, StatusReport } from './protocol.ts';

/**
 * The audio pipeline with the extension taken away.
 *
 * Everything about tab capture needs a browser profile with an unpacked
 * extension in it, a YouTube tab, and a click on a toolbar button, none of
 * which a test can have. But none of it is the part that can be wrong. The
 * parts that can be wrong are whether the delay is what the separator said,
 * whether blocks come back in order and tile the timeline, and whether the
 * instrumental actually has anything in it. All three only need a stream.
 *
 * So this page plays a local fixture in a `<video>`, takes
 * `video.captureStream()` as the pipeline's input, and puts the status, the
 * metrics and every block on `window.__karaDebug` for Playwright to read.
 * `startPipeline` is the same function the offscreen document calls, with the
 * same worklets and the same worker: the only difference is where the stream
 * came from and that `chrome.runtime.getURL` is a path on the preview server.
 *
 * The same argument applies to the picture, which is why `delayed-picture.ts`
 * is here too, running over the fixture's video exactly as it runs over
 * YouTube's. What can be wrong about it is whether the frame on screen is the
 * one the audio is playing, and that needs a video and a delay rather than a
 * tab: the fixture plays undelayed, the separated audio comes out
 * `delaySeconds` late, and the overlay paints what was on screen that long
 * ago, so `__karaDebug.pictureOffsetSeconds()` is the whole assertion. The
 * fixture's picture has its own timestamp burnt into every frame, so a test
 * that would rather read the screen than trust a number can do that instead.
 */

/** The pattern fixture: the tones, with a timestamped picture over them. */
const DEFAULT_FIXTURE = '/fixtures/pattern-240s.mp4';
const WEIGHTS_BASE = '/weights/htdemucs-web';
const RUNTIME_PATH = '/ort/';
const CAPTURE_WORKLET = '/capture-worklet.js';
const PLAYBACK_WORKLET = '/playback-worklet.js';

/** Blocks kept, which is more than any assertion needs. */
const BLOCK_HISTORY = 64;

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
  start: (fixture?: string) => Promise<void>;
  setMode: (mode: PlayMode) => void;
  setGuide: (level: number) => void;
  /** Seconds along the fixture, for testing what a seek does to both halves. */
  seek: (seconds: number) => void;
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

let pipeline: Pipeline | null = null;
let picture: DelayedPicture | null = null;
let status: StatusReport | null = null;
let metrics: Metrics | null = null;
let failure: string | null = null;
const blocks: BlockStat[] = [];

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
  return (wallNowMs() - state.paintedStampMs) / 1000 - delay;
}

function draw(): void {
  const seconds = status?.secondsLeft;
  statusLine.textContent = [
    status?.status ?? 'idle',
    seconds === null || seconds === undefined ? null : `${seconds.toFixed(1)}s left`,
    status?.reason,
    failure === null ? null : `failed: ${failure}`,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ');
  metricsBlock.textContent = JSON.stringify(
    {
      metrics,
      picture: picture?.state() ?? null,
      pictureOffsetSeconds: pictureOffsetSeconds(),
      blocks: blocks.slice(-3),
    },
    null,
    2,
  );
}

async function start(fixture = DEFAULT_FIXTURE): Promise<void> {
  await stop();
  failure = null;
  blocks.length = 0;
  video.src = fixture;
  // Deliberately not muted: `captureStream` on a muted element is not a thing
  // to rely on, and hearing the fixture undelayed next to the delayed output
  // is the cheapest way for a person to check the delay by ear.
  await video.play();

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
  picture.start(DEFAULT_DELAY_SECONDS);

  pipeline = await startPipeline({
    stream,
    weightsBase: WEIGHTS_BASE,
    runtimePath: RUNTIME_PATH,
    captureWorkletUrl: CAPTURE_WORKLET,
    playbackWorkletUrl: PLAYBACK_WORKLET,
    onStatus: (report) => {
      status = report;
      if (report.delaySeconds !== null) {
        // The measured delay replaces the guess the overlay started on.
        picture?.setDelay(report.delaySeconds);
      }
      draw();
    },
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

need<HTMLButtonElement>('#start').addEventListener('click', () => {
  start().catch(report);
});

need<HTMLButtonElement>('#mode').addEventListener('click', () => {
  pipeline?.setMode(status?.mode === 'original' ? 'instrumental' : 'original');
});

need<HTMLButtonElement>('#reset').addEventListener('click', () => {
  pipeline?.reset();
  // What the content script does on a seek, for the same reason: the frames
  // held are from a timeline the audio has just thrown away.
  picture?.clear();
  picture?.start(status?.delaySeconds ?? DEFAULT_DELAY_SECONDS);
});

need<HTMLButtonElement>('#seek').addEventListener('click', () => {
  seek(video.currentTime + 30);
});

need<HTMLButtonElement>('#picture').addEventListener('click', () => {
  if (picture?.state().active === true) {
    picture.clear();
  } else {
    picture ??= createDelayedPicture({ video, container: stage });
    picture.start(status?.delaySeconds ?? DEFAULT_DELAY_SECONDS);
  }
  draw();
});

need<HTMLButtonElement>('#stop').addEventListener('click', () => {
  stop().catch(report);
});

function seek(seconds: number): void {
  video.currentTime = Math.max(0, seconds);
}

window.__karaDebug = {
  status: () => status,
  metrics: () => metrics,
  blocks: () => blocks,
  failure: () => failure,
  picture: () => picture?.state() ?? null,
  pictureOffsetSeconds,
  start: async (fixture) => {
    await start(fixture).catch(report);
  },
  setMode: (mode) => {
    pipeline?.setMode(mode);
  },
  setGuide: (level) => {
    pipeline?.setGuide(level);
  },
  seek,
  reset: () => {
    pipeline?.reset();
  },
  stop,
};

// The overlay paints on its own animation frames; this is only so a person
// watching the page sees the numbers move with it.
setInterval(draw, 500);

const asked = new URLSearchParams(location.search);
if (asked.get('autoplay') === '1') {
  // Chrome needs --autoplay-policy=no-user-gesture-required for this, which is
  // a flag a test runner can pass and a person can click past instead.
  start(asked.get('fixture') ?? DEFAULT_FIXTURE).catch(report);
}
draw();
