#!/usr/bin/env node
// Runs the /spike page in a real browser against a synthesised fixture.
//
// Every run is watched: the page reports each phase it enters, and if no phase
// arrives for --stall seconds the run is recorded as stalled, naming the last
// phase reached, the browser is closed and the exit status is non-zero. No run
// can occupy the machine indefinitely.
//
// The fixture is ffmpeg tones and noise, so these numbers are about speed and
// memory only, and because another workload may share this machine every
// timing is an upper bound.
//
//   node scripts/spike/run-spike.mjs --mode load --model mdx-inst-hq5 --backend webgpu
//   node scripts/spike/run-spike.mjs --probe
//   node scripts/spike/run-spike.mjs --headed true --channel chrome ...
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';

import { chromium } from 'playwright';

const RESULTS_DIR = 'fixtures/generated/spike-results';
// This machine runs other dev servers, and Vite silently moves to the next
// free port when its first choice is taken. Pin a port and refuse to fall
// back, so the harness can never measure somebody else's page.
const DEFAULT_PORT = '5273';

// --mute-audio and the autoplay policy matter: a headless browser has no audio
// output device, and an AudioContext that never reaches a running state takes
// decodeAudioData down with it, silently and forever.
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

/** Machine-level memory pressure, since another workload may be running. */
function pressure() {
  const free = freemem();
  const total = totalmem();
  return {
    freeBytes: free,
    totalBytes: total,
    freeFraction: Number((free / total).toFixed(4)),
    load1: Number((loadavg()[0] ?? 0).toFixed(2)),
  };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function mib(bytes) {
  return `${(bytes / 1048576).toFixed(0)} MiB`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Starts the Vite dev server and resolves once /spike answers.
 *
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
      const response = await fetch(`${baseUrl}/spike`);
      if (response.ok) {
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

const ENVIRONMENT_SNIPPET = `(async () => {
  const adapter = navigator.gpu === undefined ? null : await navigator.gpu.requestAdapter();
  return {
    crossOriginIsolated,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory === undefined ? null : navigator.deviceMemory,
    audioContextState: await (async () => {
      try {
        const context = new AudioContext();
        const state = context.state;
        await context.close();
        return state;
      } catch (cause) {
        return 'threw: ' + String(cause);
      }
    })(),
    webgpu: adapter === null ? null : {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter === undefined
        ? adapter.isFallbackAdapter
        : adapter.info.isFallbackAdapter,
    },
    limits: adapter === null ? null : {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  };
})()`;

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const fixture = flag('fixture', 'tone-240s.wav');
  const model = flag('model', 'mdx-inst-hq5');
  const backend = flag('backend', 'webgpu');
  const mode = flag('mode', 'load');
  const segmentCap = Number(flag('segments', '4'));
  const headless = flag('headed', 'false') !== 'true';
  const channel = flag('channel', '');
  const port = flag('port', DEFAULT_PORT);
  const stallSeconds = Number(flag('stall', '90'));
  const baseUrl = `http://localhost:${port}`;

  const server = await startDevServer(baseUrl, port);
  const browser = await chromium.launch({
    headless,
    args: BROWSER_ARGS,
    ...(channel === '' ? {} : { channel }),
  });

  /** @type {{ name: string, atMs: number, sinceMs: number, detail: unknown, pressure: ReturnType<typeof pressure> }[]} */
  const phases = [];
  /** @type {string[]} */
  const consoleLines = [];
  let lastPhaseAt = Date.now();
  let lastPhaseName = 'launch';
  const began = Date.now();

  /**
   * @param {string} outcome
   * @param {Record<string, unknown>} extra
   */
  const writeReport = (outcome, extra) => {
    const target = `${RESULTS_DIR}/${model}-${backend}-${mode}-${outcome}.json`;
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          outcome,
          model,
          backend,
          mode,
          fixture,
          headless,
          channel: channel === '' ? 'bundled-chromium' : channel,
          stallSeconds,
          wallMs: Date.now() - began,
          phases,
          pressureAtEnd: pressure(),
          minFreeBytes: Math.min(...phases.map((phase) => phase.pressure.freeBytes), freemem()),
          consoleLines,
          ...extra,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`report           ${target}`);
    return target;
  };

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Chrome knows exactly why it blocked a response; the Audits domain says
    // so, where requestfailed only gives ERR_BLOCKED_BY_RESPONSE.
    /** @type {unknown[]} */
    const issues = [];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Audits.enable');
    cdp.on('Audits.issueAdded', (event) => {
      issues.push(event.issue);
      const details = JSON.stringify(event.issue);
      console.log(`issue  ${details.slice(0, 400)}`);
    });

    // Each phase the page enters resets the watchdog, so a stall is attributed
    // to the phase it stalled in rather than to the run as a whole.
    await page.exposeFunction('karaPhase', (/** @type {string} */ name, /** @type {unknown} */ detail) => {
      const now = Date.now();
      const sinceMs = now - lastPhaseAt;
      phases.push({ name, atMs: now - began, sinceMs, detail: detail ?? null, pressure: pressure() });
      lastPhaseAt = now;
      lastPhaseName = name;
      console.log(
        `phase  +${String(Math.round((now - began) / 100) / 10).padStart(6)}s  ${name}${
          detail === undefined || detail === null ? '' : ` ${JSON.stringify(detail)}`
        }`,
      );
    });

    page.on('console', (message) => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      consoleLines.push(`pageerror: ${error.message}`);
    });
    page.on('crash', () => {
      consoleLines.push('crash: renderer died');
      console.log('phase  renderer crashed');
    });

    // An idle renderer that makes no progress is usually waiting on a fetch.
    // Track every request so a stall can name the ones that never finished.
    /** @type {Map<string, { startedMs: number, status: string, corp?: string, contentType?: string }>} */
    const requests = new Map();
    const interesting = (/** @type {string} */ url) =>
      url.includes('/spike-ort/') || url.includes('/spike-models/') || url.includes('/spike-fixtures/');
    page.on('request', (request) => {
      if (interesting(request.url())) {
        requests.set(request.url(), { startedMs: Date.now() - began, status: 'pending' });
      }
    });
    page.on('response', (response) => {
      const entry = requests.get(response.url());
      if (entry !== undefined) {
        const headers = response.headers();
        entry.status = `response ${String(response.status())}`;
        entry.corp = headers['cross-origin-resource-policy'] ?? 'absent';
        entry.contentType = headers['content-type'] ?? 'absent';
      }
    });
    page.on('requestfinished', (request) => {
      const entry = requests.get(request.url());
      if (entry !== undefined) {
        entry.status = 'finished';
      }
    });
    page.on('requestfailed', (request) => {
      const entry = requests.get(request.url());
      if (entry !== undefined) {
        entry.status = `failed ${request.failure()?.errorText ?? 'unknown'}`;
      }
    });
    const requestTable = () =>
      [...requests.entries()].map(([url, entry]) => ({
        url: url.replace(baseUrl, ''),
        startedMs: entry.startedMs,
        status: entry.status,
        corp: entry.corp ?? 'n/a',
        contentType: entry.contentType ?? 'n/a',
      }));

    await page.goto(`${baseUrl}/spike`, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    if (title !== 'Kara M1 spike') {
      throw new Error(`${baseUrl}/spike served "${title}", which is not this project's page`);
    }
    await page.waitForFunction("typeof window.karaSpike === 'object'", undefined, { timeout: 60_000 });

    const environment = await page.evaluate(ENVIRONMENT_SNIPPET);
    console.log(`browser          ${String(environment.userAgent)}`);
    console.log(`channel          ${channel === '' ? 'bundled chromium' : channel}, headless ${String(headless)}`);
    console.log(`cores            ${String(environment.cores)}`);
    console.log(`cross-origin iso ${String(environment.crossOriginIsolated)}`);
    console.log(`AudioContext     ${String(environment.audioContextState)}`);
    console.log(`webgpu adapter   ${JSON.stringify(environment.webgpu)}`);
    console.log(`webgpu limits    ${JSON.stringify(environment.limits)}`);
    const start = pressure();
    console.log(`memory pressure  ${mib(start.freeBytes)} free of ${mib(start.totalBytes)}, load ${String(start.load1)}`);

    if (flags.has('probe')) {
      writeReport('probe', { environment });
      return;
    }

    if (flags.has('check')) {
      const urls = [
        '/spike-ort/ort-wasm-simd-threaded.asyncify.mjs',
        '/spike-ort/ort-wasm-simd-threaded.asyncify.mjs?import',
        '/spike-ort/ort-wasm-simd-threaded.asyncify.wasm',
        `/spike-models/${model}/UVR-MDX-NET-Inst_HQ_5.onnx`,
      ];
      const checks = await page.evaluate(`(async () => {
        const out = [];
        for (const url of ${JSON.stringify(urls)}) {
          const began = performance.now();
          try {
            const response = await fetch(url, { method: 'GET' });
            const reader = response.body === null ? null : response.body.getReader();
            let bytes = 0;
            if (reader !== null) {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 2097152) { await reader.cancel(); break; }
              }
            }
            const headers = {};
            response.headers.forEach((value, key) => { headers[key] = value; });
            out.push({ url, status: response.status, bytes, ms: Math.round(performance.now() - began), headers });
          } catch (cause) {
            out.push({ url, error: String(cause), ms: Math.round(performance.now() - began) });
          }
        }
        return out;
      })()`);
      for (const check of checks) {
        console.log(`\n${String(check.url)}`);
        console.log(`  status ${String(check.status ?? check.error)} in ${String(check.ms)}ms, ${String(check.bytes ?? 0)} bytes read`);
        if (check.headers !== undefined) {
          for (const [key, value] of Object.entries(check.headers)) {
            console.log(`  ${key}: ${String(value)}`);
          }
        }
      }
      writeReport('check', { checks, environment });
      return;
    }
    if (backend === 'webgpu' && environment.webgpu === null) {
      throw new Error('no WebGPU adapter here; rerun with --backend wasm, or --headed true --channel chrome');
    }
    if (backend === 'webgpu' && environment.webgpu.isFallbackAdapter === true) {
      throw new Error('WebGPU adapter is a software fallback; numbers would be meaningless');
    }

    const options = {
      modelId: model,
      backend,
      mode,
      maxSegments: Number.isFinite(segmentCap) && segmentCap > 0 ? segmentCap : null,
    };
    console.log(`run              ${model} / ${backend} / ${mode}, cap ${String(options.maxSegments)}`);

    lastPhaseAt = Date.now();
    /** @type {any} */
    let report;
    try {
      report = await Promise.race([
        page.evaluate(
          `window.karaSpike.runFromUrl(${JSON.stringify(`/spike-fixtures/${fixture}`)}, ${JSON.stringify(options)})`,
        ),
        new Promise((_resolve, reject) => {
          const watchdog = setInterval(() => {
            const idleMs = Date.now() - lastPhaseAt;
            if (idleMs > stallSeconds * 1000) {
              clearInterval(watchdog);
              reject(
                new Error(
                  `stalled in phase "${lastPhaseName}": no progress for ${String(Math.round(idleMs / 1000))}s`,
                ),
              );
            }
          }, 1000);
        }),
      ]);
    } catch (cause) {
      console.log(`outcome          STALLED or DIED after ${seconds(Date.now() - began)}`);
      console.log(`last phase       ${lastPhaseName}`);
      console.log(`reason           ${String(cause)}`);
      console.log('--- requests to the dev routes ---');
      for (const entry of requestTable()) {
        console.log(`  +${String(entry.startedMs)}ms ${entry.status.padEnd(22)} ${entry.url}`);
      }
      console.log('--- page console ---');
      for (const line of consoleLines.slice(-40)) {
        console.log(`  ${line}`);
      }
      console.log('--- dev server ---');
      for (const line of server.output().slice(-12)) {
        console.log(`  ${line}`);
      }
      writeReport('stalled', {
        lastPhase: lastPhaseName,
        reason: String(cause),
        requests: requestTable(),
        issues,
        environment,
      });
      process.exitCode = 1;
      return;
    }

    console.log(`wall clock       ${seconds(Date.now() - began)}`);
    if (report.outcome === 'completed' && report.run !== null) {
      const run = report.run;
      /** @type {number[]} */
      const sorted = [...run.segmentMs].sort((a, b) => a - b);
      console.log(`outcome          completed`);
      console.log(`model load       ${seconds(run.loadMs)}`);
      console.log(`segments         ${String(run.segments)}`);
      if (sorted.length > 0) {
        console.log(
          `segment ms       median ${String(Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0))}, min ${String(Math.round(sorted[0] ?? 0))}, max ${String(Math.round(sorted[sorted.length - 1] ?? 0))}`,
        );
        console.log(`audio covered    ${String(run.audioSeconds.toFixed(1))}s`);
        console.log(`realtime factor  ${String(run.realtimeFactor.toFixed(2))}x (upper bound: shared machine)`);
      }
      console.log(`peak worker heap ${run.peakJsHeapBytes === null ? 'n/a' : mib(run.peakJsHeapBytes)}`);
      console.log(
        `agent memory     ${report.memoryBefore?.agentBytes === null ? 'n/a' : mib(report.memoryBefore?.agentBytes ?? 0)} -> ${report.memoryAfter?.agentBytes === null ? 'n/a' : mib(report.memoryAfter?.agentBytes ?? 0)}`,
      );
      console.log(
        `main thread      ${String(report.mainThread?.frames)} frames, worst gap ${String(Math.round(report.mainThread?.maxGapMs ?? 0))}ms, ${String(report.mainThread?.longFrames)} over 50ms`,
      );
      const end = pressure();
      console.log(`memory pressure  ${mib(end.freeBytes)} free at end, load ${String(end.load1)}`);
      for (const stem of run.stems) {
        console.log(`stem             ${String(stem.name)} ${mib(stem.bytes)} at ${String(stem.opfsPath)}`);
      }
      for (const caveat of run.caveats) {
        console.log(`caveat           ${String(caveat)}`);
      }
      writeReport('completed', { report, environment });
    } else {
      console.log(`outcome          FAILED: ${String(report.error)}`);
      for (const line of consoleLines.slice(-30)) {
        console.log(`  ${line}`);
      }
      writeReport('failed', { report, environment });
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.stop();
  }
}

await main();
