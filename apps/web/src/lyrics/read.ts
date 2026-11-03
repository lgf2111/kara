import { sourceBlob, videoTypeFor } from '../library/storage.ts';
import type { LyricLine } from '../library/songs.ts';
import { estimateRemainingMs } from '../separation/job.ts';
import type { Store } from '../storage/store.ts';
import {
  candidateBands,
  pickBand,
  scoreBand,
  type Band,
  type BandTrial,
} from './bands.ts';
import { openFrameReader } from './frames.ts';
import { durationStats, linesFromFrames, toLyricLines, type OcrFrame } from './lines.ts';
import { rowEdgeEnergy } from './pixels.ts';
import type { LyricsMessage, LyricsRequest } from './protocol.ts';

/**
 * Reading timed lyric lines off a video the library already keeps.
 *
 * Three passes. The first samples frames across the whole video and measures
 * how busy each row is, which says where the words might be. The second runs
 * OCR on the best few of those bands over a handful of frames and keeps the
 * one that reads most confidently. The third works through the video at a
 * couple of frames a second, cropped to that band, and groups the readings
 * into lines.
 *
 * Nothing it reads is logged. The one summary it prints carries counts and
 * timings, because those are what the thresholds are tuned against.
 */

/** Frames a second in the main pass, which is the rate the node spike measured. */
const SAMPLE_FPS = 2;

/** Frames used to look for the text band, spread evenly over the video. */
const PROBE_FRAMES = 30;

/** Width a probe frame is downscaled to before its rows are measured. */
const PROBE_WIDTH = 480;

/** Bands that get an OCR trial. */
const CANDIDATES = 3;

/** Frames each candidate band is tried on. */
const TRIAL_FRAMES = 6;

/** A band is upscaled by this much before OCR: small capitals need the pixels. */
const CROP_SCALE = 2;

export type LyricsStage =
  | 'reading the file'
  | 'opening the video'
  | 'finding the words'
  | 'choosing where to look'
  | 'reading the words';

export interface LyricsProgress {
  readonly stage: LyricsStage;
  readonly framesDone: number;
  readonly framesTotal: number;
  readonly etaMs: number | null;
}

/** Counts and timings only: the lines themselves are in the outcome. */
export interface LyricsStats {
  readonly framesRead: number;
  /** Frames whose reading ended up inside a line. */
  readonly framesKept: number;
  readonly lines: number;
  /** The band the lines were read from, or null when none read anything. */
  readonly band: Band | null;
  /** Mean OCR confidence over the frames that were kept. */
  readonly confidence: number;
  readonly medianLineSeconds: number | null;
  readonly ocrMs: number;
  readonly totalMs: number;
}

export interface LyricsOutcome {
  readonly lines: readonly LyricLine[];
  /** Cancelled runs carry whatever was read; nothing is saved from them. */
  readonly cancelled: boolean;
  readonly stats: LyricsStats;
}

export interface RunningLyricsRead {
  readonly finished: Promise<LyricsOutcome>;
  cancel(): void;
}

export interface LyricsReadOptions {
  readonly store: Store;
  /** OPFS path of the video kept with the song. */
  readonly path: string;
  readonly onProgress: (progress: LyricsProgress) => void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** `count` times spread evenly over the video, each in the middle of its share. */
function evenTimes(seconds: number, count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => ((index + 0.5) * seconds) / count);
}

function sampleTimes(seconds: number, fps: number): number[] {
  const total = Math.max(1, Math.ceil(seconds * fps));
  return Array.from({ length: total }, (_unused, index) => index / fps);
}

export function readLyricsFromVideo(options: LyricsReadOptions): RunningLyricsRead {
  const { store, path, onProgress } = options;
  const worker = new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module' });
  const opened = deferred<void>();
  // Nothing awaits this until the video is open, and the worker can fail
  // before then, so the rejection is claimed now rather than reported as
  // nobody's. The await below still sees it.
  void opened.promise.catch(() => undefined);
  const waiting = new Map<number, Deferred<OcrFrame>>();
  let nextId = 0;
  let cancelled = false;
  let ocrMs = 0;

  const breakOff = (cause: unknown): void => {
    opened.reject(cause);
    for (const waiter of waiting.values()) {
      waiter.reject(cause);
    }
    waiting.clear();
  };

  worker.addEventListener('message', (event: MessageEvent<LyricsMessage>) => {
    const message = event.data;
    if (message.kind === 'ready') {
      opened.resolve();
      return;
    }
    if (message.kind === 'failed') {
      breakOff(new Error(`${message.stage}: ${message.error}`));
      return;
    }
    const waiter = waiting.get(message.id);
    if (waiter !== undefined) {
      waiting.delete(message.id);
      waiter.resolve({ seconds: 0, text: message.text, confidence: message.confidence });
    }
  });
  worker.addEventListener('error', (event) => {
    breakOff(new Error(event.message === '' ? 'the lyrics worker stopped' : event.message));
  });

  const send = (request: LyricsRequest): void => {
    worker.postMessage(request);
  };

  /** One crop through OCR, timed so the summary can say what it cost. */
  const recognise = async (seconds: number, image: Blob): Promise<OcrFrame> => {
    nextId += 1;
    const id = nextId;
    const waiter = deferred<OcrFrame>();
    waiting.set(id, waiter);
    const began = performance.now();
    send({ kind: 'read', id, image });
    try {
      const reading = await waiter.promise;
      return { ...reading, seconds };
    } finally {
      ocrMs += performance.now() - began;
    }
  };

  async function run(): Promise<LyricsOutcome> {
    const startedAt = performance.now();
    let band: Band | null = null;
    const frames: OcrFrame[] = [];

    const outcome = (): LyricsOutcome => {
      const lines = linesFromFrames(frames, { frameSeconds: 1 / SAMPLE_FPS });
      const durations = durationStats(lines);
      const kept = lines.reduce((total, line) => total + line.frames, 0);
      const weighted = lines.reduce((total, line) => total + line.confidence * line.frames, 0);
      return {
        lines: toLyricLines(lines),
        cancelled,
        stats: {
          framesRead: frames.length,
          framesKept: kept,
          lines: lines.length,
          band,
          confidence: kept === 0 ? 0 : weighted / kept,
          medianLineSeconds: durations.medianSeconds,
          ocrMs: Math.round(ocrMs),
          totalMs: Math.round(performance.now() - startedAt),
        },
      };
    };

    onProgress({ stage: 'reading the file', framesDone: 0, framesTotal: 0, etaMs: null });
    const blob = await sourceBlob(store, path, videoTypeFor(path));
    if (cancelled) {
      return outcome();
    }

    onProgress({ stage: 'opening the video', framesDone: 0, framesTotal: 0, etaMs: null });
    const reader = await openFrameReader(blob);
    try {
      send({ kind: 'open' });
      await opened.promise;

      const seconds = reader.durationSeconds;
      const probes = evenTimes(seconds, PROBE_FRAMES);
      const energies: Float32Array[] = [];
      for (const [index, at] of probes.entries()) {
        if (cancelled) {
          return outcome();
        }
        await reader.seek(at);
        const frame = reader.gray(PROBE_WIDTH);
        energies.push(rowEdgeEnergy(frame.gray, frame.width, frame.height));
        onProgress({
          stage: 'finding the words',
          framesDone: index + 1,
          framesTotal: probes.length,
          etaMs: null,
        });
      }

      // Times outer, bands inner: one seek pays for all three crops.
      const candidates = candidateBands(energies, CANDIDATES);
      const readings = candidates.map((): OcrFrame[] => []);
      const trialTimes = evenTimes(seconds, TRIAL_FRAMES);
      for (const [index, at] of trialTimes.entries()) {
        if (cancelled) {
          return outcome();
        }
        await reader.seek(at);
        for (const [candidate, option] of candidates.entries()) {
          const image = await reader.band(option, CROP_SCALE);
          const reading = await recognise(at, image);
          readings[candidate]?.push(reading);
        }
        onProgress({
          stage: 'choosing where to look',
          framesDone: index + 1,
          framesTotal: trialTimes.length,
          etaMs: null,
        });
      }

      const best = pickBand(
        candidates.map(
          (option, index): BandTrial => scoreBand(option, readings[index] ?? []),
        ),
      );
      if (best === null) {
        return outcome();
      }
      const chosen = best.band;
      band = chosen;

      const times = sampleTimes(seconds, SAMPLE_FPS);
      const frameMs: number[] = [];
      for (const [index, at] of times.entries()) {
        if (cancelled) {
          break;
        }
        const began = performance.now();
        await reader.seek(at);
        const image = await reader.band(chosen, CROP_SCALE);
        frames.push(await recognise(at, image));
        frameMs.push(performance.now() - began);
        onProgress({
          stage: 'reading the words',
          framesDone: index + 1,
          framesTotal: times.length,
          etaMs: estimateRemainingMs(frameMs, times.length - index - 1),
        });
      }
    } finally {
      reader.close();
    }
    return outcome();
  }

  const finished = run().finally(() => {
    worker.terminate();
  });

  return {
    finished,
    cancel() {
      // Flagged rather than killed, the way a separation run is. The frame it
      // is on takes about half a second to finish, and stopping between frames
      // leaves nothing half-written.
      cancelled = true;
    },
  };
}

/** One line for the console: counts and timings, never a word of what was read. */
export function describeRead(outcome: LyricsOutcome): string {
  const stats = outcome.stats;
  return [
    `lyrics: ${String(stats.lines)} lines from ${String(stats.framesRead)} frames`,
    `${String(stats.framesKept)} kept at confidence ${stats.confidence.toFixed(1)}`,
    stats.band === null
      ? 'no band read anything'
      : `band y ${stats.band.top.toFixed(2)}-${stats.band.bottom.toFixed(2)}`,
    `median line ${stats.medianLineSeconds === null ? 'n/a' : `${String(stats.medianLineSeconds)}s`}`,
    `ocr ${(stats.ocrMs / 1000).toFixed(0)}s of ${(stats.totalMs / 1000).toFixed(0)}s`,
    ...(outcome.cancelled ? ['cancelled'] : []),
  ].join(', ');
}
