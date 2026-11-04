#!/usr/bin/env node
// Fills apps/web/dist with the files the built site fetches from its own
// origin, so a Pages deploy is self-contained: the separation weights, the
// ONNX runtime, and the OCR worker, core and language data.
//
//   pnpm --filter ./apps/web build && node scripts/prepare-deploy.mjs
//
// Pages refuses any asset over 25 MiB. The runtime's wasm is bigger, so it is
// shipped gzipped (the worker unzips it), and the plain copy the build emitted
// is removed. Every file is checked against the limit at the end.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const web = join(repoRoot, 'apps/web');
const dist = join(web, 'dist');
const require = createRequire(join(web, 'package.json'));
const LIMIT = 25 * 1024 * 1024;

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`prepare-deploy: ${message}`);
  process.exit(1);
}

/**
 * @param {string} from
 * @param {string} toDir
 * @param {(name: string) => boolean} [keep]
 */
function copyInto(from, toDir, keep = () => true) {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(from)) {
    if (keep(name) && statSync(join(from, name)).isFile()) {
      copyFileSync(join(from, name), join(toDir, name));
    }
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

if (!existsSync(dist)) {
  fail('apps/web/dist is missing; run the build first');
}

const weights = join(repoRoot, 'models/htdemucs-web');
if (!existsSync(weights)) {
  fail('models/htdemucs-web is missing; fetch it with scripts/spike/models.mjs');
}
copyInto(weights, join(dist, 'weights/htdemucs-web'));

const ort = dirname(require.resolve('onnxruntime-web'));
const ortOut = join(dist, 'spike-ort');
copyInto(ort, ortOut, (name) => name === 'ort-wasm-simd-threaded.asyncify.mjs');
writeFileSync(
  join(ortOut, 'ort-wasm-simd-threaded.asyncify.wasm.gz'),
  gzipSync(readFileSync(join(ort, 'ort-wasm-simd-threaded.asyncify.wasm')), { level: 9 }),
);

const tesseractDist = join(dirname(require.resolve('tesseract.js')), '../dist');
const coreDir = dirname(
  require.resolve('tesseract.js-core/package.json', { paths: [require.resolve('tesseract.js')] }),
);
const tessdata = join(repoRoot, 'models/tessdata');
if (!existsSync(join(tessdata, 'eng.traineddata'))) {
  fail('models/tessdata/eng.traineddata is missing; see docs/lyrics-ocr.md');
}
copyInto(tesseractDist, join(dist, 'tesseract'), (name) => name === 'worker.min.js');
copyInto(coreDir, join(dist, 'tesseract/core'), (name) => name.endsWith('.wasm.js'));
copyInto(tessdata, join(dist, 'tesseract/tessdata'), (name) => name === 'eng.traineddata');

// The build emits the runtime wasm as an asset too, but the worker is given
// the unzipped bytes and never fetches it.
for (const file of readdirSync(join(dist, 'assets'))) {
  const path = join(dist, 'assets', file);
  if (file.endsWith('.wasm') && statSync(path).size > LIMIT) {
    rmSync(path);
  }
}

const tooBig = filesUnder(dist).filter((path) => statSync(path).size > LIMIT);
if (tooBig.length > 0) {
  fail(`over the 25 MiB asset limit: ${tooBig.join(', ')}`);
}
console.log(`prepare-deploy: ${String(filesUnder(dist).length)} files, none over 25 MiB`);
