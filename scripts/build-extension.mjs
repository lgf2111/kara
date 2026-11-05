#!/usr/bin/env node
// Builds apps/extension into a dist/ Chrome can load unpacked, and fills it
// with everything the extension reads at runtime: the separation weights and
// the ONNX runtime's wasm. Nothing it loads comes from the network, so nothing
// may be left out.
//
//   node scripts/build-extension.mjs             # bundle, weights if present
//   node scripts/build-extension.mjs --weights   # fail unless the weights are there
//   node scripts/build-extension.mjs --localhost # also match http://localhost/*
//
// The bundling is four vite builds rather than one, because an extension's
// pieces are not all the same kind of file: apps/extension/vite.config.ts says
// which and why. The target is passed in the environment so that every build
// stays a production build, which is what the separation engine reads to
// decide how to load the runtime's wasm.
//
// A sibling of scripts/prepare-deploy.mjs, which does the same job for the
// deployed site. The difference is the limit: Pages refuses an asset over
// 25 MiB and an unpacked extension does not care, so the runtime is shipped
// gzipped here only because the engine already knows how to read it that way.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const extension = join(repoRoot, 'apps/extension');
const dist = join(extension, 'dist');
const require = createRequire(join(extension, 'package.json'));

/** Anything bigger than this in dist/assets is a wasm nothing ever fetches. */
const STRAY_LIMIT = 8 * 1024 * 1024;

const TARGETS = ['pages', 'stem-player', 'content', 'stream-info'];

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`build-extension: ${message}`);
  process.exit(1);
}

/**
 * @param {string} from
 * @param {string} toDir
 * @param {(name: string) => boolean} [keep]
 * @returns {number}
 */
function copyInto(from, toDir, keep = () => true) {
  mkdirSync(toDir, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(from)) {
    if (keep(name) && statSync(join(from, name)).isFile()) {
      copyFileSync(join(from, name), join(toDir, name));
      copied += 1;
    }
  }
  return copied;
}

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const args = process.argv.slice(2);
const requireWeights = args.includes('--weights');
const localhost = args.includes('--localhost');
for (const arg of args) {
  if (arg !== '--weights' && arg !== '--localhost') {
    fail(`unknown option ${arg}`);
  }
}

// vite is a dependency of the extension package, not of the repository root,
// so its bin is found through the package that declares it.
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
if (!existsSync(viteBin)) {
  fail('vite is not installed in apps/extension; run pnpm install');
}

for (const target of TARGETS) {
  const result = spawnSync(process.execPath, [viteBin, 'build'], {
    cwd: extension,
    stdio: 'inherit',
    env: {
      ...process.env,
      KARA_EXT_TARGET: target,
      KARA_EXT_LOCALHOST: localhost ? '1' : '0',
    },
  });
  if (result.status !== 0) {
    fail(`the ${target} build failed`);
  }
}

if (!existsSync(dist)) {
  fail('the build produced no dist/');
}

// The pages build emits the runtime's wasm as an asset as well, because
// onnxruntime-web names the file in its own glue. The runner is handed the
// bytes and never fetches it, so a 25 MiB copy in dist/assets is dead weight.
const assets = join(dist, 'assets');
if (existsSync(assets)) {
  for (const name of readdirSync(assets)) {
    const path = join(assets, name);
    if (name.endsWith('.wasm') && statSync(path).size > STRAY_LIMIT) {
      rmSync(path);
    }
  }
}

const ort = dirname(require.resolve('onnxruntime-web'));
const ortOut = join(dist, 'ort');
const glue = copyInto(ort, ortOut, (name) => name.endsWith('.asyncify.mjs'));
if (glue === 0) {
  fail(`no asyncify glue in ${ort}; onnxruntime-web has changed its file names`);
}
writeFileSync(
  join(ortOut, 'ort-wasm-simd-threaded.asyncify.wasm.gz'),
  gzipSync(readFileSync(join(ort, 'ort-wasm-simd-threaded.asyncify.wasm')), { level: 9 }),
);
console.log(`build-extension: ort runtime, ${String(glue)} glue file(s) and the gzipped wasm`);

// The key control is Signalsmith Stretch, loaded as a worklet. The package is
// a single ES module with its WASM embedded, so it is one static file the
// extension can load as `self`.
const signalsmith = dirname(require.resolve('signalsmith-stretch'));
copyFileSync(join(signalsmith, 'SignalsmithStretch.mjs'), join(dist, 'signalsmith-stretch.js'));
console.log('build-extension: pitch-shift worklet');

const weights = join(repoRoot, 'models/htdemucs-web');
if (existsSync(weights)) {
  const copied = copyInto(weights, join(dist, 'weights/htdemucs-web'));
  console.log(`build-extension: weights, ${String(copied)} file(s)`);
} else if (requireWeights) {
  fail('models/htdemucs-web is missing; fetch it with scripts/spike/models.mjs');
} else {
  console.log(
    'build-extension: models/htdemucs-web is missing, so this dist cannot separate anything. ' +
      'Pass --weights to make that a failure.',
  );
}

console.log(
  `build-extension: ${String(filesUnder(dist).length)} files in apps/extension/dist` +
    `${localhost ? ', matching localhost as well as youtube.com' : ''}`,
);
