#!/usr/bin/env node
// Measures how well OCR reads timed lyric lines off a lyric video.
//
// The question this answers: if somebody uploads a video that already has the
// words burned into the picture, can we read them well enough to time a line,
// and what does it cost? It samples the video a couple of times a second, runs
// tesseract.js over every frame, and groups runs of frames that read the same
// into lines with a start and an end.
//
//   node scripts/spike/lyric-ocr.mjs --input ~/Music/video.mp4
//   node scripts/spike/lyric-ocr.mjs --input ~/Music/video.mp4 --fps 4 --lang eng
//
// Flags: --input <path> (required), --fps N (default 2), --lang <code>
// (default eng, '+' separated for several), --seconds N (sample only the first
// N seconds, 0 means all), --keep-frames.
//
// What goes where, and why:
//
// Nothing it reads off the screen is ever printed. The words in a lyric video
// are somebody else's, so stdout gets counts and timings only, and the lines
// themselves are written to
// fixtures/generated/lyric-ocr/<name>/lines.json, which is gitignored. The
// sampled frames land beside it and are deleted at the end unless
// --keep-frames is passed; at 1080p they are a megabyte or two each, so a
// four-minute video at 2 fps is most of a gigabyte while the run is going.
//
// The video stays where it is: ffmpeg reads it in place and nothing is copied
// into this repository.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import tesseract from 'tesseract.js';

import {
  DEFAULTS,
  dominantRegion,
  durationStats,
  keepFrame,
  linesFromFrames,
  pngSize,
  unionBox,
} from '../lib/lyric-ocr.mjs';
import { outputNameFor } from '../lib/stems.mjs';

const { OEM, PSM, createWorker } = tesseract;

const RESULTS_DIR = 'fixtures/generated/lyric-ocr';

/** Language data is downloaded once and cached here, not in the working directory. */
const TESSDATA_DIR = `${RESULTS_DIR}/tessdata`;

/** Below this a single word is too doubtful to say where the text sits. */
const MIN_WORD_CONFIDENCE = 60;

/**
 * @param {readonly string[]} argv
 * @returns {Map<string, string>}
 */
function parseFlags(argv) {
  /** @type {Map<string, string>} */
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) {
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(token.slice(2), 'true');
    } else {
      flags.set(token.slice(2), next);
      i += 1;
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

/**
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function flag(name, fallback) {
  return flags.get(name) ?? fallback;
}

/**
 * @param {string} label
 * @param {string | number} value
 */
function report(label, value) {
  console.log(`${label.padEnd(17)}${String(value)}`);
}

/**
 * Samples the video into PNG frames with ffmpeg.
 *
 * @param {string} inputPath
 * @param {string} framesDir
 * @param {number} fps
 * @param {number} seconds 0 for the whole video
 * @param {string} prep extra ffmpeg filters after fps, e.g. a crop and contrast boost, or ''
 * @returns {string[]} frame paths in time order
 */
function sampleFrames(inputPath, framesDir, fps, seconds, prep) {
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const result = spawnSync(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...(seconds > 0 ? ['-t', String(seconds)] : []),
      ...['-i', inputPath],
      '-an',
      ...['-vf', `fps=${String(fps)}${prep === '' ? '' : `,${prep}`}`],
      `${framesDir}/frame-%06d.png`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not sample ${inputPath}: ${(result.stderr ?? '').trim()}`);
  }
  return readdirSync(framesDir)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => `${framesDir}/${name}`);
}

/**
 * Where OCR found words it is sure of. The text itself is left behind: this is
 * only used to say which part of the frame the lyrics live in.
 *
 * @param {import('tesseract.js').Block[] | null} blocks
 * @returns {import('../lib/lyric-ocr.mjs').Box[]}
 */
function confidentWordBoxes(blocks) {
  /** @type {import('../lib/lyric-ocr.mjs').Box[]} */
  const boxes = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          if (word.confidence >= MIN_WORD_CONFIDENCE) {
            boxes.push(word.bbox);
          }
        }
      }
    }
  }
  return boxes;
}

async function main() {
  const inputFlag = flags.get('input');
  if (inputFlag === undefined || inputFlag === 'true') {
    throw new Error('--input <video> is required');
  }
  const inputPath = resolve(inputFlag);
  const fps = Number(flag('fps', '2'));
  const lang = flag('lang', 'eng');
  const seconds = Number(flag('seconds', '0'));

  if (!Number.isFinite(fps) || fps <= 0 || fps > 30) {
    throw new Error(`--fps takes a number between 0 and 30, got ${flag('fps', '2')}`);
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`--seconds takes 0 or more, got ${flag('seconds', '0')}`);
  }
  // The language code becomes part of a file path and a download URL, so it is
  // checked rather than trusted.
  if (!/^[a-z]{3}(\+[a-z]{3})*$/u.test(lang)) {
    throw new Error(`--lang takes three-letter codes joined by '+', got ${lang}`);
  }
  if (statSync(inputPath, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`--input ${inputPath} is not a file`);
  }

  const name = outputNameFor(inputPath);
  const outputDir = `${RESULTS_DIR}/${name}`;
  const framesDir = `${outputDir}/frames`;
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(TESSDATA_DIR, { recursive: true });

  report('input', inputPath);
  report('fps', fps);
  report('language', lang);

  const sampleBegan = Date.now();
  const framePaths = sampleFrames(inputPath, framesDir, fps, seconds, flags.get('prep') ?? '');
  if (framePaths.length === 0) {
    throw new Error(`ffmpeg sampled no frames from ${inputPath}: is there a video track?`);
  }
  const sampleMs = Date.now() - sampleBegan;

  const firstFrame = framePaths[0] ?? '';
  const size = pngSize(readFileSync(firstFrame).subarray(0, 24));

  const worker = await createWorker(lang, OEM.LSTM_ONLY, {
    cachePath: TESSDATA_DIR,
    logger: () => {},
    errorHandler: (/** @type {unknown} */ cause) => {
      console.error(`ocr worker error: ${String(cause)}`);
    },
  });
  // Fixed rather than left to the default, so two runs of this script are
  // measuring the same thing. A video frame is a page with a line or two of
  // text somewhere on it, which is what automatic segmentation is for.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });

  /** @type {import('../lib/lyric-ocr.mjs').Frame[]} */
  const frames = [];
  /** @type {import('../lib/lyric-ocr.mjs').Box[]} */
  const boxes = [];
  let framesWithText = 0;
  let framesKept = 0;
  let confidenceSum = 0;
  let ocrMs = 0;

  try {
    for (const [index, framePath] of framePaths.entries()) {
      const began = Date.now();
      const { data } = await worker.recognize(framePath, {}, { text: true, blocks: true });
      ocrMs += Date.now() - began;

      const frame = {
        seconds: Math.round((index / fps) * 1000) / 1000,
        text: data.text ?? '',
        confidence: data.confidence ?? 0,
      };
      frames.push(frame);
      if ((data.text ?? '').trim() !== '') {
        framesWithText += 1;
      }
      if (keepFrame(frame)) {
        framesKept += 1;
        confidenceSum += frame.confidence;
        const box = unionBox(confidentWordBoxes(data.blocks));
        if (box !== null) {
          boxes.push(box);
        }
      }

      const done = index + 1;
      if (done % 25 === 0 || done === framePaths.length) {
        report('ocr', `${String(done)}/${String(framePaths.length)} frames, ${(ocrMs / 1000).toFixed(0)}s`);
      }
    }
  } finally {
    await worker.terminate();
    if (!flags.has('keep-frames')) {
      rmSync(framesDir, { recursive: true, force: true });
    }
  }

  const frameSeconds = 1 / fps;
  const lines = linesFromFrames(frames, { frameSeconds });
  const durations = durationStats(lines);
  const sampledSeconds = framePaths.length * frameSeconds;
  const sungSeconds = lines.reduce((total, line) => total + (line.endSeconds - line.startSeconds), 0);

  // The only place recognised text is allowed to go. fixtures/generated is
  // gitignored, and these words came off somebody's own video, so they are
  // theirs: treat the file the way you treat the video.
  const linesPath = `${outputDir}/lines.json`;
  writeFileSync(
    linesPath,
    `${JSON.stringify(
      {
        source: inputPath,
        fps,
        lang,
        sampledFrames: framePaths.length,
        grouping: { ...DEFAULTS, frameSeconds },
        lines,
      },
      null,
      2,
    )}\n`,
  );

  report('frames sampled', `${String(framePaths.length)} over ${sampledSeconds.toFixed(1)}s, in ${(sampleMs / 1000).toFixed(1)}s`);
  report(
    'frames with text',
    `${String(framesWithText)} (${((100 * framesWithText) / framePaths.length).toFixed(0)}%)`,
  );
  report(
    'frames kept',
    `${String(framesKept)} (${((100 * framesKept) / framePaths.length).toFixed(0)}%), confidence >= ${String(DEFAULTS.minConfidence)}`,
  );
  report('lines found', durations.count);
  report(
    'line duration',
    durations.count === 0
      ? 'no lines'
      : `median ${String(durations.medianSeconds)}s, min ${String(durations.minSeconds)}s, max ${String(durations.maxSeconds)}s`,
  );
  report(
    'lines cover',
    `${sungSeconds.toFixed(1)}s of ${sampledSeconds.toFixed(1)}s (${((100 * sungSeconds) / sampledSeconds).toFixed(0)}%)`,
  );
  report(
    'ocr cost',
    `${(ocrMs / framePaths.length / 1000).toFixed(2)}s per frame, ${(ocrMs / 1000).toFixed(0)}s total`,
  );
  report(
    'mean confidence',
    framesKept === 0 ? 'no frames kept' : `${(confidenceSum / framesKept).toFixed(1)} over kept frames`,
  );
  report('frame size', size === null ? 'unknown' : `${String(size.width)}x${String(size.height)}`);

  const region = size === null ? null : dominantRegion(boxes, { ...size, grid: 10 });
  report(
    'text region',
    region === null
      ? 'not enough boxed frames to guess'
      : `x ${region.left.toFixed(2)}-${region.right.toFixed(2)}, y ${region.top.toFixed(2)}-${region.bottom.toFixed(2)} of the frame, busiest cell in ${(100 * region.coverage).toFixed(0)}% of them`,
  );
  report('lines written', `${linesPath} (gitignored, not printed)`);
  if (flags.has('keep-frames')) {
    report('frames kept at', framesDir);
  }
}

await main();
