import type { MediaSample } from './audio/media-time.ts';
import {
  DEFAULT_MIX,
  type Stem,
  type StemMix,
  withMute,
  withSolo,
  withStem,
} from './audio/stems.ts';
import { prepareDetail } from './content/panel-view.ts';
import { startEngine, type Engine } from './offscreen/engine.ts';
import { wallNowMs } from './picture/wall-clock.ts';
import { reasonText } from './reason.ts';
import type {
  Metrics,
  PipelineDebug,
  PlayMode,
  PrepareStage,
  StatusReport,
} from './protocol.ts';

/**
 * The audio engine with the extension taken away.
 *
 * Everything about the extension needs a browser profile with an unpacked
 * extension in it, a YouTube tab, and a click, none of which a test can have.
 * But none of it is the part that can be wrong. The parts that can be wrong
 * are whether the audio is read, separated and played where the video is —
 * and those only need a video and a file.
 *
 * So this page plays a local fixture in a `<video>`, hands the same fixture's
 * audio to `startEngine` as the stream, and reports the video's clock the way
 * the content script does. `startEngine` is the same function the offscreen
 * document calls, with the same worklet and the same worker: the only
 * difference is that the stream URL is a path on the preview server rather
 * than one the page reported, and `chrome.runtime.getURL` is the same path by
 * another name.
 *
 * What is worth asserting on has shrunk with the delay:
 *
 * - {@link KaraDebug.progress} never goes backwards and reaches `ready`.
 * - {@link KaraDebug.mediaSeconds} sits on the fixture's own clock once the
 *   toggle is on, and a seek moves it to the new place.
 * - {@link KaraDebug.dominantHz} proves the key moved the pitch by
 *   `2 ** (semitones / 12)`, and that nothing about the timing moved with it.
 */

/** The tone fixture: a known frequency, so the key can be measured off it. */
const DEFAULT_FIXTURE = '/fixtures/tone-15s.wav';
const WEIGHTS_BASE = '/weights/htdemucs-web';
const RUNTIME_PATH = '/ort/';
const PLAYBACK_WORKLET = '/stem-player.js';
const PITCH_WORKLET = '/signalsmith-stretch.js';

/** Progress samples kept, more than any assertion needs. */
const PROGRESS_HISTORY = 2400;

/** How often the page tells the engine where the video is. */
const MEDIA_TICK_MS = 250;

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
  /** Whether it got all the way to ready. */
  readonly ready: boolean;
}

export interface KaraDebug {
  status: () => StatusReport | null;
  metrics: () => Metrics | null;
  /** The engine's own debug state, including which backend it ran on. */
  pipeline: () => PipelineDebug | null;
  failure: () => string | null;
  progress: () => ProgressTrace;
  /** Where the stems are playing in the song, or null while silent. */
  mediaSeconds: () => number | null;
  start: (fixture?: string) => Promise<void>;
  setMode: (mode: PlayMode) => void;
  /** The whole mixer in one call. */
  setMix: (mix: StemMix) => void;
  /** One stem, which is the convenient shape for a test. */
  setStem: (stem: Stem, level: number) => void;
  /** One stem's mute switch. */
  setMute: (stem: Stem, muted: boolean) => void;
  /** One stem's solo switch. */
  setSolo: (stem: Stem, soloed: boolean) => void;
  /** The old name for the vocal stem, kept so a familiar console line works. */
  setGuide: (level: number) => void;
  /** The key, in semitones, which the player applies last of all. */
  setTranspose: (semitones: number) => void;
  /** The loudest frequency coming out of the player, off an analyser. */
  dominantHz: () => number | null;
  /** The loudest frequency near `hz`, where a known partial should have gone. */
  peakHz: (hz: number, spread?: number) => number | null;
  /** The largest absolute sample leaving the player, or null without an analyser. */
  peakLevel: () => number | null;
  /** Seconds along the fixture, for testing what a seek does. */
  seek: (seconds: number) => void;
  pause: () => void;
  play: () => Promise<void>;
  stop: () => Promise<void>;
}

declare global {
  interface Window {
    __karaDebug?: KaraDebug;
  }
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

const asked = new URLSearchParams(location.search);

let engine: Engine | null = null;
let status: StatusReport | null = null;
let metrics: Metrics | null = null;
let failure: string | null = null;
let mediaTicker: ReturnType<typeof setInterval> | null = null;
let muted = false;

const progressSamples: ProgressSample[] = [];
let monotonic = true;
let maxFraction = 0;

function playingNow(): boolean {
  return (
    !video.paused && !video.ended && !video.seeking && video.readyState >= video.HAVE_FUTURE_DATA
  );
}

function mediaSample(): MediaSample {
  return {
    wallMs: wallNowMs(),
    mediaSeconds: video.currentTime,
    playing: playingNow(),
    rate: video.playbackRate,
    inAd: false,
  };
}

function tellMedia(): void {
  engine?.media(mediaSample());
}

/** The video's mute is the page's half of the switch, as in the content script. */
function syncMute(): void {
  const wanted = status?.mode === 'instrumental' && status.status === 'ready' && playingNow();
  muted = wanted === true;
  video.muted = muted;
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
      mode: status?.mode ?? 'original',
      mix: status?.mix ?? DEFAULT_MIX,
      semitones: status?.semitones ?? 0,
      dominantHz: engine?.dominantHz() ?? null,
      muted,
      progress: { monotonic, max: maxFraction, samples: progressSamples.length },
    },
    null,
    2,
  );
}

function onStatus(next: StatusReport): void {
  status = next;
  syncMute();
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
  draw();
}

function onMetrics(next: Metrics): void {
  metrics = next;
  draw();
}

async function start(fixture: string): Promise<void> {
  await stop();
  failure = null;
  progressSamples.length = 0;
  monotonic = true;
  maxFraction = 0;
  video.src = fixture;
  // The fixture plays audibly while the engine prepares, which is the point:
  // the video carries on while the analysis happens, and the toggle takes
  // over when it is ready.
  video.muted = false;
  await video.play();
  engine = await startEngine({
    stream: { videoId: 'fixture', url: fixture, mimeType: 'audio/wav' },
    weightsBase: WEIGHTS_BASE,
    runtimePath: RUNTIME_PATH,
    playbackWorkletUrl: PLAYBACK_WORKLET,
    pitchWorkletUrl: PITCH_WORKLET,
    // So `dominantHz` has something to read. The packed extension never asks.
    analyse: true,
    onStatus,
    onMetrics,
  });
  tellMedia();
  mediaTicker = setInterval(tellMedia, MEDIA_TICK_MS);
  syncMute();
  draw();
}

async function stop(): Promise<void> {
  const running = engine;
  engine = null;
  if (mediaTicker !== null) {
    clearInterval(mediaTicker);
    mediaTicker = null;
  }
  video.pause();
  video.muted = false;
  muted = false;
  if (running !== null) {
    await running.stop();
  }
}

function report(cause: unknown): void {
  failure = reasonText(cause);
  draw();
}

window.__karaDebug = {
  status: () => status,
  metrics: () => metrics,
  pipeline: () => engine?.debug() ?? null,
  failure: () => failure,
  progress: () => ({
    samples: progressSamples,
    monotonic,
    max: maxFraction,
    ready: status?.status === 'ready' || status?.status === 'paused',
  }),
  mediaSeconds: () => metrics?.mediaSeconds ?? null,
  start: async (fixture) => {
    await start(fixture ?? DEFAULT_FIXTURE).catch(report);
  },
  setMode: (mode) => {
    engine?.setMode(mode);
  },
  setMix: (mix) => {
    engine?.setMix(mix);
  },
  setStem: (stem, level) => {
    engine?.setMix(withStem(status?.mix ?? DEFAULT_MIX, stem, level));
  },
  setMute: (stem, muted) => {
    engine?.setMix(withMute(status?.mix ?? DEFAULT_MIX, stem, muted));
  },
  setSolo: (stem, soloed) => {
    engine?.setMix(withSolo(status?.mix ?? DEFAULT_MIX, stem, soloed));
  },
  setGuide: (level) => {
    engine?.setMix(withStem(status?.mix ?? DEFAULT_MIX, 'vocals', level));
  },
  setTranspose: (semitones) => {
    engine?.setKey(semitones);
  },
  dominantHz: () => engine?.dominantHz() ?? null,
  peakHz: (hz, spread) => engine?.peakHz(hz, spread) ?? null,
  peakLevel: () => engine?.peakLevel() ?? null,
  seek: (seconds) => {
    video.currentTime = Math.max(0, seconds);
  },
  pause: () => {
    video.pause();
  },
  play: async () => {
    await video.play();
  },
  stop,
};

need<HTMLButtonElement>('#start').addEventListener('click', () => {
  void start(DEFAULT_FIXTURE).catch(report);
});

need<HTMLButtonElement>('#mode').addEventListener('click', () => {
  engine?.setMode(status?.mode === 'original' ? 'instrumental' : 'original');
});

need<HTMLButtonElement>('#seek').addEventListener('click', () => {
  video.currentTime += 5;
});

need<HTMLButtonElement>('#hold').addEventListener('click', () => {
  if (video.paused) {
    void video.play();
    return;
  }
  video.pause();
});

need<HTMLButtonElement>('#key-down').addEventListener('click', () => {
  engine?.setKey((status?.semitones ?? 0) - 1);
});

need<HTMLButtonElement>('#key-up').addEventListener('click', () => {
  engine?.setKey((status?.semitones ?? 0) + 1);
});

need<HTMLButtonElement>('#stop').addEventListener('click', () => {
  void stop().catch(report);
});

setInterval(draw, 500);

if (asked.get('autoplay') === '1') {
  const fixture = asked.get('fixture') ?? DEFAULT_FIXTURE;
  start(fixture).catch(report);
}
draw();
