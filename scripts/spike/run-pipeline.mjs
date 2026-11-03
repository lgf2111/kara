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
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';

import { chromium } from 'playwright';

const RESULTS_DIR = 'fixtures/generated/pipeline-results';
const PROFILE_DIR = 'fixtures/generated/chrome-profile';
const DEFAULT_PORT = '5274';

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

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });

  const fixture = flag('fixture', 'tone-240s.wav');
  const backend = flag('backend', 'webgpu');
  const segments = Number(flag('segments', '0'));
  const killAfter = Number(flag('kill-after', '0'));
  const stallSeconds = Number(flag('stall', '150'));
  const headless = flag('headed', 'false') !== 'true';
  const port = flag('port', DEFAULT_PORT);
  const baseUrl = `http://localhost:${port}`;
  const label = flag('label', killAfter > 0 ? 'killed' : 'run');

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
    console.log(`profile          ${PROFILE_DIR}`);
    console.log(
      `memory pressure  ${(start.freeBytes / 1048576).toFixed(0)} MiB free, load ${String(start.load1)}`,
    );

    const options = {
      url: `/spike-fixtures/${fixture}`,
      backend,
      overlap: 0.25,
      maxSegments: Number.isFinite(segments) && segments > 0 ? segments : null,
      optimisation: flag('opt', 'all'),
    };

    /** @type {any} */
    let result = null;
    /** @type {string | null} */
    let failure = null;
    try {
      result = await Promise.race([
        page.evaluate(`window.karaPipeline.run(${JSON.stringify(options)})`),
        new Promise((_resolve, reject) => {
          const watchdog = setInterval(() => {
            if (Date.now() - lastPhaseAt > stallSeconds * 1000) {
              clearInterval(watchdog);
              reject(new Error(`stalled in phase "${lastPhaseName}"`));
            }
          }, 1000);
        }),
      ]);
    } catch (cause) {
      failure = String(cause);
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
      console.log(
        `stem sum error   ${result.stemSumError === null ? 'n/a' : `${(Number(result.stemSumError) * 100).toFixed(2)}%`}`,
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
    server.stop();
  }
}

await main();
