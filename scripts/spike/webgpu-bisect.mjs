#!/usr/bin/env node
// Finds out why the htdemucs chain returns NaN on WebGPU and the right numbers
// on WASM, by driving /webgpu-bisect in a real browser with WebGPU on.
//
//   node scripts/spike/webgpu-bisect.mjs                     # the whole report
//   node scripts/spike/webgpu-bisect.mjs --only compare      # just both sides
//   node scripts/spike/webgpu-bisect.mjs --only nodes        # the node table
//   node scripts/spike/webgpu-bisect.mjs --piece htdemucs_p04.onnx
//   node scripts/spike/webgpu-bisect.mjs --gain 0.01         # a quiet input
//   node scripts/spike/webgpu-bisect.mjs --shape silent      # every bin empty
//
// Needs the weights: `node scripts/spike/models.mjs fetch htdemucs-web`. The
// input is synthesised from a seed inside the page, so no audio and no file of
// anybody's goes anywhere near this.
//
// Writes fixtures/generated/pipeline-results/webgpu-bisect-<label>.json, which
// is gitignored, and prints a summary of it.
//
// Flags: --piece FILE, --seed N, --gain F, --shape mixed|tonal|silent,
// --tolerance F, --opt LEVEL, --only env|nodes|compare|bisect|options|report,
// --port N, --headed true, --stall SECONDS, --label NAME.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

import { chromium } from 'playwright';

const RESULTS_DIR = 'fixtures/generated/pipeline-results';
// Pinned and strict: this machine runs other dev servers, and Vite moving to
// the next free port would have the harness measure somebody else's page.
const DEFAULT_PORT = '5275';

const BROWSER_ARGS = [
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--use-angle=metal',
  '--mute-audio',
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
      if ((await fetch(`${baseUrl}/webgpu-bisect`)).ok) {
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
 * @param {unknown} value
 * @param {number} width
 * @returns {string}
 */
function cell(value, width) {
  const text = value === null || value === undefined ? '-' : String(value);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function short(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e5)) {
    return value.toExponential(2);
  }
  return value.toFixed(magnitude < 1 ? 4 : 2);
}

/**
 * One tensor comparison as a line: counts and ranges, never a value in place.
 *
 * @param {any} tensor
 * @returns {string}
 */
function tensorLine(tensor) {
  const bad = Number(tensor.candidate?.nonFinite ?? 0);
  const of = Number(tensor.candidate?.count ?? 0);
  const share = of > 0 ? `${((bad / of) * 100).toFixed(2)}%` : '-';
  return [
    `  ${cell(tensor.verdict, 11)}`,
    cell(tensor.name, 44),
    cell(tensor.type, 8),
    cell(`[${(tensor.dims ?? []).join(',')}]`, 20),
    `bad ${cell(`${String(bad)}/${String(of)} ${share}`, 24)}`,
    `wasm ${cell(`${short(tensor.reference?.min)}..${short(tensor.reference?.max)}`, 20)}`,
    `gpu ${cell(`${short(tensor.candidate?.min)}..${short(tensor.candidate?.max)}`, 20)}`,
    `relerr ${short(tensor.drift?.maxRel)}`,
  ].join(' ');
}

/**
 * @param {any} tensor
 */
function printAxes(tensor) {
  for (const axis of tensor.axes ?? []) {
    const positions = Number(axis.badPositions ?? 0);
    const extent = Number(axis.extent ?? 0);
    if (positions > 0 && positions < extent) {
      console.log(
        `      axis ${String(axis.axis)}: ${String(positions)} of ${String(extent)} positions bad, ` +
          `first ${String(axis.firstBad)}, last ${String(axis.lastBad)}`,
      );
    } else if (positions === extent && extent > 0) {
      console.log(`      axis ${String(axis.axis)}: all ${String(extent)} positions bad`);
    }
  }
  for (const span of tensor.candidate?.badSpans ?? []) {
    console.log(`      bad run [${String(span.from)}, ${String(span.to)})`);
  }
}

/**
 * @param {any} value
 */
function printSummary(value) {
  if (value === null || typeof value !== 'object') {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  // Each block recognises its own shape, so --only prints the same lines the
  // full report does.
  const where = value.environment ?? (value.adapterFeatures === undefined ? null : value);
  if (where !== null) {
    console.log(`adapter          ${JSON.stringify(where.adapter)}`);
    console.log(`adapter features ${(where.adapterFeatures ?? []).join(', ') || 'none'}`);
    console.log(`ort              ${JSON.stringify(where.ort)}`);
    console.log(`isolated         ${String(where.crossOriginIsolated)}`);
  }
  const graph = value.graph ?? (value.count === undefined ? null : value);
  if (graph !== null) {
    console.log(`piece            ${String(graph.piece)}, ${String(graph.count)} nodes`);
    console.log(`initializers     ${JSON.stringify(graph.initializerTypes)}`);
    const types = Object.entries(graph.opTypes ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]));
    console.log(`op types         ${types.map(([name, count]) => `${name} ${String(count)}`).join(', ')}`);
  }
  if (value.rows !== undefined) {
    for (const row of value.rows) {
      console.log(
        `  ${String(row.index).padStart(4)}  ${cell(row.opType, 22)} ${cell(row.name, 56)} ` +
          `${cell(row.output, 48)} ${row.castTo === null ? '' : `cast to ${String(row.castTo)}`}`,
      );
    }
  }

  const comparison = value.compare ?? (value.outputs !== undefined ? value : null);
  if (comparison !== null) {
    console.log(`input            ${JSON.stringify(comparison.input)}`);
    if ((comparison.prefix ?? []).length > 0) {
      console.log(`prefix on wasm   ${JSON.stringify(comparison.prefix)}`);
    }
    console.log(
      `run              wasm ${String(comparison.wasmMs)} ms, webgpu ${String(comparison.webgpuMs)} ms`,
    );
    console.log(`reproduced       ${String(comparison.reproduced)}`);
    for (const tensor of comparison.outputs ?? []) {
      console.log(tensorLine(tensor));
      printAxes(tensor);
    }
  }

  const found = value.bisect ?? (value.probes !== undefined ? value : null);
  if (found !== null) {
    console.log(`\nbisect           ${String(found.steps)} probes, ${String(found.note)}`);
    if (found.anchor !== null && found.anchor !== undefined) {
      console.log(
        `anchor           ${String(found.anchor.output)} from node ${String(found.anchor.nodeIndex)}`,
      );
    }
    for (const probe of found.probes ?? []) {
      console.log(
        `  probe ${String(probe.index).padStart(4)}  ${cell(probe.verdict, 11)} ` +
          `${cell(probe.node?.opType, 20)} ${cell(probe.node?.name, 52)} ` +
          `exposed ${cell(probe.exposedAs, 9)} ${probe.error ?? ''}`,
      );
    }
    if (found.lastGood !== null && found.lastGood !== undefined) {
      console.log(
        `last good        ${String(found.lastGood.index)} ${String(found.lastGood.opType)} ${String(found.lastGood.name)}`,
      );
    }
    if (found.firstBad !== null && found.firstBad !== undefined) {
      console.log(
        `FIRST BAD        ${String(found.firstBad.index)} ${String(found.firstBad.opType)} ${String(found.firstBad.name)}`,
      );
    }
    for (const row of found.window ?? []) {
      console.log(
        `  near ${String(row.index).padStart(4)}  ${cell(row.opType, 22)} ${cell(row.name, 56)} ` +
          `${row.castTo === null ? '' : `cast to ${String(row.castTo)}`}`,
      );
    }
    for (const tensor of found.detail?.tensors ?? []) {
      console.log(tensorLine(tensor));
      printAxes(tensor);
    }
  }

  const matrix = value.options ?? (Array.isArray(value) ? value : null);
  if (matrix !== null) {
    console.log('\nsession options');
    for (const outcome of matrix) {
      console.log(
        `  ${cell(outcome.worstVerdict, 11)} ${cell(outcome.name, 46)} ` +
          `${cell(outcome.shape, 7)} gain ${cell(outcome.gain, 6)} ` +
          `empty bins ${cell(outcome.emptyBins, 5)} ` +
          `create ${cell(`${String(outcome.createMs)} ms`, 9)} ` +
          `run ${cell(`${String(outcome.runMs)} ms`, 9)} ${outcome.error ?? ''}`,
      );
      // One line for the first output that went wrong, so a row that changed
      // the answer can be told from one that only changed the timing.
      const worst = (outcome.outputs ?? []).find(
        (/** @type {any} */ tensor) => tensor.verdict !== 'clean',
      );
      if (worst !== undefined) {
        console.log(tensorLine(worst));
      }
    }
  }
  if (value.suspects !== undefined) {
    console.log(`\nsuspect op types ${(value.suspects ?? []).join(', ')}`);
  }
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const only = flag('only', 'report');
  const method = only === 'env' ? 'environment' : only === 'options' ? 'sweep' : only;
  if (!['environment', 'nodes', 'compare', 'bisect', 'sweep', 'report'].includes(method)) {
    throw new Error(`--only takes env, nodes, compare, bisect, options or report, got ${only}`);
  }
  const headless = flag('headed', 'false') !== 'true';
  const port = flag('port', DEFAULT_PORT);
  const baseUrl = `http://localhost:${port}`;
  const stallSeconds = Number(flag('stall', '240'));
  const label = flag('label', only);
  const shape = flag('shape', 'mixed');
  if (!['mixed', 'tonal', 'silent'].includes(shape)) {
    throw new Error(`--shape takes mixed, tonal or silent, got ${shape}`);
  }
  const options = {
    piece: flag('piece', 'htdemucs_p00.onnx'),
    seed: Number(flag('seed', '1337')),
    gain: Number(flag('gain', '1')),
    shape,
    tolerance: Number(flag('tolerance', '0.01')),
    optimisation: flag('opt', 'disabled'),
  };

  const server = await startDevServer(baseUrl, port);
  const browser = await chromium.launch({ headless, args: BROWSER_ARGS });

  const began = Date.now();
  /** @type {{ name: string, atMs: number, detail: unknown }[]} */
  const phases = [];
  /** @type {string[]} */
  const consoleLines = [];
  let lastPhaseAt = Date.now();
  let lastPhaseName = 'launch';

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.exposeFunction('karaPhase', (/** @type {string} */ name, /** @type {unknown} */ detail) => {
      lastPhaseAt = Date.now();
      lastPhaseName = name;
      phases.push({ name, atMs: Date.now() - began, detail: detail ?? null });
      console.log(
        `phase  +${String(Math.round((Date.now() - began) / 100) / 10).padStart(6)}s  ${name}${
          detail === undefined || detail === null ? '' : ` ${JSON.stringify(detail)}`
        }`,
      );
    });
    page.on('console', (message) => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
      while (consoleLines.length > 400) {
        consoleLines.shift();
      }
    });
    page.on('pageerror', (error) => {
      consoleLines.push(`pageerror: ${error.message}`);
    });

    await page.goto(`${baseUrl}/webgpu-bisect`, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    if (title !== 'Kara WebGPU bisect') {
      throw new Error(`${baseUrl}/webgpu-bisect served "${title}"`);
    }
    await page.waitForFunction("typeof window.karaBisect === 'object'", undefined, { timeout: 60_000 });

    console.log(`piece            ${options.piece}`);
    console.log(`step             ${only}`);
    console.log(
      `input            seed ${String(options.seed)}, gain ${String(options.gain)}, ${options.shape}`,
    );
    console.log(`optimisation     ${options.optimisation}`);

    /** @type {ReturnType<typeof setInterval> | undefined} */
    let watchdog;
    /** @type {any} */
    let result = null;
    /** @type {string | null} */
    let failure = null;
    try {
      result = await Promise.race([
        page.evaluate(`window.karaBisect.${method}(${JSON.stringify(options)})`),
        new Promise((_resolve, reject) => {
          watchdog = setInterval(() => {
            if (Date.now() - lastPhaseAt > stallSeconds * 1000) {
              reject(new Error(`stalled in phase "${lastPhaseName}"`));
            }
          }, 1000);
        }),
      ]);
    } catch (cause) {
      failure = String(cause);
    } finally {
      clearInterval(watchdog);
    }

    const wallMs = Date.now() - began;
    if (result === null || result === undefined) {
      console.log(`\noutcome          FAILED: ${String(failure)}`);
      console.log(`last phase       ${lastPhaseName}`);
      for (const line of consoleLines.slice(-25)) {
        console.log(`  ${line}`);
      }
      process.exitCode = 1;
    } else {
      console.log('');
      printSummary(result);
    }
    console.log(`\nwall clock       ${(wallMs / 1000).toFixed(1)} s`);

    const target = `${RESULTS_DIR}/webgpu-bisect-${label}.json`;
    writeFileSync(
      target,
      `${JSON.stringify({ step: only, options, wallMs, result, failure, phases, consoleLines }, null, 2)}\n`,
    );
    console.log(`report           ${target}`);
  } finally {
    await browser.close();
    server.stop();
  }
}

await main();
