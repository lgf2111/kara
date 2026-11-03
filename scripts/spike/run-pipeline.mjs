#!/usr/bin/env node
// Drives the product separation pipeline at /pipeline in a real browser.
//
// Uses a persistent browser profile, so OPFS survives between invocations and
// `--kill-after N` can prove that a job resumes after the browser is gone
// rather than starting again.
//
//   node scripts/spike/run-pipeline.mjs --segments 6
//   node scripts/spike/run-pipeline.mjs --segments 6 --kill-after 3
//   node scripts/spike/run-pipeline.mjs --segments 6          # resumes
//
// A real song you own, separated end to end, with stems to listen to:
//
//   node scripts/spike/run-pipeline.mjs --input ~/Music/song.mp4
//
// Audio or video, whatever Chrome can decode the audio track of, including an
// mp4 whose video is AV1. The file stays where it is: Playwright hands it to
// the page's file input and the browser decodes it, exactly as a person
// choosing it would, and nothing is copied into this repository. When Chrome
// refuses the container the script converts it first, with
//
//   ffmpeg -i <input> -vn -ac 2 -ar 44100 -c:a pcm_s16le <temp>.wav
//
// into the system temp directory, not the repository, and deletes it after.
//
// Stems are written as 16-bit WAV under
// fixtures/generated/pipeline-results/<name>/, which is gitignored. They are
// derived from your own file, so treat them the way you treat the original.
//
// Separation runs on WASM. The WebGPU backend returns NaN for every value of
// this model's chain, so `--backend` accepts nothing else.
//
// Flags: --input <path>, --fixture <name>, --segments N (0 means the whole
// track), --stems all|pair, --no-wav, --kill-after N, --stall S, --clear,
// --inspect, --headed true, --port N, --label NAME, --opt LEVEL.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

import { floatToPcm16, outputNameFor, wavHeader } from '../lib/stems.mjs';

const RESULTS_DIR = 'fixtures/generated/pipeline-results';
const PROFILE_DIR = 'fixtures/generated/chrome-profile';
const DEFAULT_PORT = '5274';

/** Matches FILE_INPUT_ID in apps/web/src/PipelineApp.tsx. */
const FILE_INPUT = '#pipeline-file';

/** Everything is decoded to this, so every stem has this shape. */
const STEM_SAMPLE_RATE = 44100;
const STEM_CHANNELS = 2;
const STEM_FRAME_BYTES = STEM_CHANNELS * Float32Array.BYTES_PER_ELEMENT;

/**
 * Bytes pulled out of the browser at a time. Base64 inflates this by a third
 * on the wire, and it has to be a whole number of frames so a sample never
 * straddles two chunks.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

const BROWSER_ARGS = [
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--use-angle=metal',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
];

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

function pressure() {
  return {
    freeBytes: freemem(),
    totalBytes: totalmem(),
    load1: Number((loadavg()[0] ?? 0).toFixed(2)),
  };
}

/**
 * @typedef {object} TreeMemory
 * @property {number} processes
 * @property {number} totalKb
 * @property {Record<string, number>} byType
 */

/**
 * Resident memory of the browser we launched, found by its profile directory so
 * the unrelated Chromium on this machine is not counted.
 *
 * @param {string} profileDir
 * @returns {TreeMemory | null}
 */
function browserMemory(profileDir) {
  const result = spawnSync('ps', ['-axo', 'pid,ppid,rss,command'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  /** @type {{ pid: number, ppid: number, rssKb: number, command: string }[]} */
  const rows = [];
  for (const line of result.stdout.split('\n').slice(1)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match !== null) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKb: Number(match[3]),
        command: match[4] ?? '',
      });
    }
  }
  const root = rows.find((row) => row.command.includes(profileDir) && !row.command.includes('--type='));
  if (root === undefined) {
    return null;
  }
  /** @type {Map<number, typeof rows>} */
  const children = new Map();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  /** @type {Record<string, number>} */
  const byType = {};
  let totalKb = 0;
  let processes = 0;
  const stack = [root.pid];
  const seen = new Set();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const row = byPid.get(pid);
    if (row !== undefined) {
      const type = /--type=([a-z-]+)/u.exec(row.command)?.[1] ?? 'browser';
      byType[type] = (byType[type] ?? 0) + row.rssKb;
      totalKb += row.rssKb;
      processes += 1;
    }
    for (const child of children.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }
  return { processes, totalKb, byType };
}

/**
 * @param {string} baseUrl
 * @param {string} port
 * @returns {Promise<{ stop: () => void, output: () => string[] }>}
 */
async function startDevServer(baseUrl, port) {
  const child = spawn('pnpm', ['exec', 'vite', '--port', port, '--strictPort'], {
    cwd: 'apps/web',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  /** @type {string[]} */
  const output = [];
  const keep = (/** @type {Buffer} */ chunk) => {
    output.push(chunk.toString('utf8').trimEnd());
    while (output.length > 40) {
      output.shift();
    }
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const stop = () => {
    child.kill('SIGTERM');
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/pipeline`)).ok) {
        return { stop, output: () => output };
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(`dev server did not start within 60s:\n${output.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * Decodes a container Chrome will not take into a plain WAV it will.
 *
 * The result goes to the system temp directory on purpose. Decoded audio from
 * somebody's own music must not land inside this repository, even somewhere
 * gitignored, so it is written outside, used, and deleted by the caller.
 *
 * @param {string} inputPath
 * @returns {string} path to the temporary WAV
 */
function ffmpegToWav(inputPath) {
  const target = `${tmpdir()}/kara-decode-${String(process.pid)}-${String(Date.now())}.wav`;
  const result = spawnSync(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-i', inputPath],
      '-vn',
      ...['-ac', String(STEM_CHANNELS)],
      ...['-ar', String(STEM_SAMPLE_RATE)],
      ...['-c:a', 'pcm_s16le'],
      target,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not decode ${inputPath}: ${(result.stderr ?? '').trim()}`);
  }
  return target;
}

/**
 * Copies every finished stem out of OPFS as a 16-bit WAV.
 *
 * Pulled in chunks rather than whole: a four-minute stem is 80 MB of float32
 * and this target has had as little as 100 MB free.
 *
 * @param {import('playwright').Page} page
 * @param {{ name: string, path: string, bytes: number }[]} stems
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function exportStemWavs(page, stems, directory) {
  mkdirSync(directory, { recursive: true });
  /** @type {string[]} */
  const written = [];
  // One output buffer for every chunk of every stem: 16-bit is half the size
  // of the float32 that comes out of the browser.
  const pcm = new Uint8Array(CHUNK_BYTES / 2);

  for (const stem of stems) {
    const bytes = Math.floor(Number(stem.bytes) / STEM_FRAME_BYTES) * STEM_FRAME_BYTES;
    const target = `${directory}/${stem.name}.wav`;
    if (bytes === 0) {
      console.log(`stem wav         ${stem.name} is empty, skipped`);
      continue;
    }

    writeFileSync(
      target,
      wavHeader({
        frames: bytes / STEM_FRAME_BYTES,
        channels: STEM_CHANNELS,
        sampleRate: STEM_SAMPLE_RATE,
      }),
    );

    for (let offset = 0; offset < bytes; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, bytes - offset);
      const base64 = await page.evaluate(
        `window.karaPipeline.readStemChunk(${JSON.stringify(stem.path)}, ${String(offset)}, ${String(length)})`,
      );
      // Copy into a fresh array: Buffer.from hands back a view into a pooled
      // buffer at an arbitrary offset, which Float32Array cannot read.
      const aligned = new Uint8Array(Buffer.from(String(base64), 'base64'));
      const floats = new Float32Array(
        aligned.buffer,
        0,
        Math.floor(aligned.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
      appendFileSync(target, floatToPcm16(floats, pcm.subarray(0, floats.length * 2)));
    }

    written.push(target);
    console.log(
      `stem wav         ${target} (${(bytes / STEM_FRAME_BYTES / STEM_SAMPLE_RATE).toFixed(1)}s)`,
    );
  }
  return written;
}

/**
 * @param {number} value
 * @returns {string}
 */
function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Every segment's stem-sum error, not just a summary: one bad segment
 * disappears into an average.
 *
 * @param {number[]} errors
 * @param {number} firstSegment
 */
function printSumErrors(errors, firstSegment) {
  if (errors.length === 0) {
    console.log('stem sum error   not measured');
    return;
  }
  const sorted = [...errors].sort((a, b) => a - b);
  console.log(
    `stem sum error   median ${percent(sorted[Math.floor(sorted.length / 2)] ?? 0)}, min ${percent(
      sorted[0] ?? 0,
    )}, max ${percent(sorted[sorted.length - 1] ?? 0)} over ${String(errors.length)} segment(s)`,
  );
  for (let i = 0; i < errors.length; i += 6) {
    const row = errors
      .slice(i, i + 6)
      .map((value, column) => `${String(firstSegment + i + column + 1).padStart(3)}:${percent(value)}`);
    console.log(`  ${row.join('  ')}`);
  }
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });

  const fixture = flag('fixture', 'tone-240s.wav');
  const inputFlag = flags.get('input');
  const inputPath = inputFlag === undefined ? null : resolve(inputFlag);
  const backend = flag('backend', 'wasm');
  const stems = flag('stems', 'all');
  const segments = Number(flag('segments', '0'));
  const killAfter = Number(flag('kill-after', '0'));
  const stallSeconds = Number(flag('stall', '150'));
  const headless = flag('headed', 'false') !== 'true';
  const port = flag('port', DEFAULT_PORT);
  const baseUrl = `http://localhost:${port}`;
  const outputName = outputNameFor(inputPath ?? fixture);
  const label = flag('label', killAfter > 0 ? 'killed' : inputPath === null ? 'run' : outputName);

  if (backend !== 'wasm') {
    throw new Error(
      `--backend ${backend} is not available: WebGPU returns NaN for every value of this model's chain`,
    );
  }
  if (stems !== 'all' && stems !== 'pair') {
    throw new Error(`--stems takes all or pair, got ${stems}`);
  }
  if (inputPath !== null && statSync(inputPath, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`--input ${inputPath} is not a file`);
  }

  const server = await startDevServer(baseUrl, port);
  // A persistent profile is the point: OPFS has to outlive the browser for a
  // resume to mean anything.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args: BROWSER_ARGS,
  });

  const began = Date.now();
  /** @type {{ name: string, atMs: number, detail: unknown }[]} */
  const phases = [];
  /** @type {string[]} */
  const consoleLines = [];
  let lastPhaseAt = Date.now();
  let lastPhaseName = 'launch';
  let peak = /** @type {TreeMemory | null} */ (null);
  let killed = false;
  let temporaryWav = /** @type {string | null} */ (null);

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    await page.exposeFunction('karaPhase', (/** @type {string} */ name, /** @type {unknown} */ detail) => {
      lastPhaseAt = Date.now();
      lastPhaseName = name;
      phases.push({ name, atMs: Date.now() - began, detail: detail ?? null });
      const memory = browserMemory(PROFILE_DIR);
      if (memory !== null && (peak === null || memory.totalKb > peak.totalKb)) {
        peak = memory;
      }
      console.log(
        `phase  +${String(Math.round((Date.now() - began) / 100) / 10).padStart(6)}s  ${name}${
          detail === undefined || detail === null ? '' : ` ${JSON.stringify(detail)}`
        }`,
      );

      // Kill the browser the moment the job has done enough segments. No
      // cleanup, no final flush: exactly what closing a tab looks like.
      const done = /** @type {{ done?: number } | null} */ (detail)?.done;
      if (killAfter > 0 && name === 'separating' && typeof done === 'number' && done >= killAfter) {
        killed = true;
        console.log(`phase  killing the browser after ${String(done)} segments`);
        void context.close();
      }
    });

    page.on('console', (message) => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      consoleLines.push(`pageerror: ${error.message}`);
    });

    await page.goto(`${baseUrl}/pipeline`, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    if (title !== 'Kara separation pipeline') {
      throw new Error(`${baseUrl}/pipeline served "${title}"`);
    }
    await page.waitForFunction("typeof window.karaPipeline === 'object'", undefined, {
      timeout: 60_000,
    });

    if (flags.has('clear')) {
      await page.evaluate('window.karaPipeline.clear()');
      console.log('cleared any saved jobs');
    }

    if (flags.has('inspect')) {
      const state = await page.evaluate(
        `window.karaPipeline.jobState(${JSON.stringify(fixture)}, 42336078, 10584000)`,
      );
      const sizes = await page.evaluate(
        `window.karaPipeline.stemSizes(${JSON.stringify(fixture)}, 42336078, 10584000)`,
      );
      console.log(`job state        ${JSON.stringify(state)}`);
      console.log(`stem sizes       ${JSON.stringify(sizes)}`);
      return;
    }

    const start = pressure();
    console.log(`backend          ${backend}`);
    console.log(`stems            ${stems}`);
    console.log(`source           ${inputPath ?? `fixtures/generated/${fixture} (synthesised)`}`);
    console.log(`profile          ${PROFILE_DIR}`);
    console.log(
      `memory pressure  ${(start.freeBytes / 1048576).toFixed(0)} MiB free, load ${String(start.load1)}`,
    );

    const options = {
      url: `/spike-fixtures/${fixture}`,
      backend,
      overlap: 0.25,
      maxSegments: Number.isFinite(segments) && segments > 0 ? segments : null,
      stems,
      optimisation: flag('opt', 'all'),
    };

    /**
     * One attempt, with the stall watchdog running only for its duration so a
     * retry starts with a clean one.
     *
     * @param {string} method
     * @returns {Promise<unknown>}
     */
    const attempt = async (method) => {
      /** @type {ReturnType<typeof setInterval> | undefined} */
      let watchdog;
      try {
        return await Promise.race([
          page.evaluate(`window.karaPipeline.${method}(${JSON.stringify(options)})`),
          new Promise((_resolve, reject) => {
            watchdog = setInterval(() => {
              if (Date.now() - lastPhaseAt > stallSeconds * 1000) {
                reject(new Error(`stalled in phase "${lastPhaseName}"`));
              }
            }, 1000);
          }),
        ]);
      } finally {
        clearInterval(watchdog);
      }
    };

    if (inputPath !== null) {
      // Playwright reads the file from where it sits. Nothing is copied into
      // the repository, and the page decodes it as it would any chosen file.
      await page.setInputFiles(FILE_INPUT, inputPath);
    }

    /** @type {any} */
    let result = null;
    /** @type {string | null} */
    let failure = null;
    try {
      result = await attempt(inputPath === null ? 'run' : 'runFile');
    } catch (cause) {
      failure = String(cause);
    }

    // Chrome accepts containers it cannot actually decode. One retry, through
    // ffmpeg, from a temporary file outside this repository.
    if (inputPath !== null && result === null && failure?.includes('decode-failed') === true) {
      console.log('decode           Chrome refused the container, converting with ffmpeg');
      temporaryWav = ffmpegToWav(inputPath);
      await page.setInputFiles(FILE_INPUT, temporaryWav);
      failure = null;
      try {
        result = await attempt('runFile');
      } catch (cause) {
        failure = String(cause);
      }
    }

    const wallMs = Date.now() - began;
    if (killed) {
      console.log(`outcome          KILLED after ${String(killAfter)} segments, as intended`);
    } else if (result === null) {
      console.log(`outcome          FAILED or STALLED: ${String(failure)}`);
      console.log(`last phase       ${lastPhaseName}`);
      for (const line of consoleLines.slice(-25)) {
        console.log(`  ${line}`);
      }
    } else {
      console.log(`outcome          completed`);
      console.log(`job              ${String(result.jobId)}`);
      console.log(
        `segments         ${String(result.segmentsDone)}/${String(result.segmentsTotal)}, resumed from ${String(result.resumedFrom)}`,
      );
      console.log(`model load       ${(Number(result.loadMs) / 1000).toFixed(2)}s`);
      console.log(`inference        ${(Number(result.inferenceMs) / 1000).toFixed(1)}s`);
      console.log(`wall clock       ${(wallMs / 1000).toFixed(1)}s`);
      console.log(`audio written    ${Number(result.audioSeconds).toFixed(1)}s`);
      printSumErrors(
        (result.stemSumErrors ?? []).map((/** @type {unknown} */ value) => Number(value)),
        Number(result.resumedFrom ?? 0),
      );
      console.log(`diagnostics      ${JSON.stringify(result.diagnostics ?? {})}`);
      const host = Object.entries(result.hostMs ?? {});
      const hostTotal = host.reduce((sum, [, ms]) => sum + Number(ms), 0);
      console.log(
        `host stages      ${String(Math.round(hostTotal))} ms total, ${String(Math.round(hostTotal / Math.max(1, Number(result.segmentsDone) - Number(result.resumedFrom))))} ms per segment`,
      );
      for (const [name, ms] of host.sort((a, b) => Number(b[1]) - Number(a[1]))) {
        console.log(`  ${name.padEnd(10)} ${String(Math.round(Number(ms))).padStart(7)} ms`);
      }
      for (const stem of result.stems ?? []) {
        console.log(
          `stem             ${String(stem.name)} ${(Number(stem.bytes) / 1048576).toFixed(1)} MiB at ${String(stem.path)}`,
        );
      }
      if (flags.has('no-wav')) {
        console.log('stem wav         skipped (--no-wav)');
      } else {
        await exportStemWavs(page, result.stems ?? [], `${RESULTS_DIR}/${outputName}`);
      }
    }
    if (peak !== null) {
      const parts = Object.entries(peak.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([type, kb]) => `${type} ${String(Math.round(kb / 1024))}`)
        .join(', ');
      console.log(
        `peak browser RSS ${String(Math.round(peak.totalKb / 1024))} MiB across ${String(peak.processes)} processes (MiB: ${parts})`,
      );
    }

    const target = `${RESULTS_DIR}/htdemucs-${backend}-${label}.json`;
    writeFileSync(
      target,
      `${JSON.stringify(
        { outcome: killed ? 'killed' : result === null ? 'failed' : 'completed', killAfter, wallMs, result, failure, phases, peak, consoleLines },
        null,
        2,
      )}\n`,
    );
    console.log(`report           ${target}`);
    if (!killed && result === null) {
      process.exitCode = 1;
    }
  } finally {
    try {
      await context.close();
    } catch {
      // already closed by the kill
    }
    if (temporaryWav !== null) {
      rmSync(temporaryWav, { force: true });
    }
    server.stop();
  }
}

await main();
