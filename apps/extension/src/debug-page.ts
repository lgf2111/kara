import { startPipeline, type Pipeline } from './offscreen/pipeline.ts';
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
 */

const DEFAULT_FIXTURE = '/fixtures/tone-240s.wav';
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
  start: (fixture?: string) => Promise<void>;
  setMode: (mode: PlayMode) => void;
  setGuide: (level: number) => void;
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
const statusLine = need<HTMLParagraphElement>('#status');
const metricsBlock = need<HTMLPreElement>('#metrics');

let pipeline: Pipeline | null = null;
let status: StatusReport | null = null;
let metrics: Metrics | null = null;
let failure: string | null = null;
const blocks: BlockStat[] = [];

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
    { metrics, blocks: blocks.slice(-3) },
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

  pipeline = await startPipeline({
    stream,
    weightsBase: WEIGHTS_BASE,
    runtimePath: RUNTIME_PATH,
    captureWorkletUrl: CAPTURE_WORKLET,
    playbackWorkletUrl: PLAYBACK_WORKLET,
    onStatus: (report) => {
      status = report;
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
});

need<HTMLButtonElement>('#stop').addEventListener('click', () => {
  stop().catch(report);
});

window.__karaDebug = {
  status: () => status,
  metrics: () => metrics,
  blocks: () => blocks,
  failure: () => failure,
  start: async (fixture) => {
    await start(fixture).catch(report);
  },
  setMode: (mode) => {
    pipeline?.setMode(mode);
  },
  setGuide: (level) => {
    pipeline?.setGuide(level);
  },
  reset: () => {
    pipeline?.reset();
  },
  stop,
};

const asked = new URLSearchParams(location.search);
if (asked.get('autoplay') === '1') {
  // Chrome needs --autoplay-policy=no-user-gesture-required for this, which is
  // a flag a test runner can pass and a person can click past instead.
  start(asked.get('fixture') ?? DEFAULT_FIXTURE).catch(report);
}
draw();
