#!/usr/bin/env node
// Lists or downloads the spike's candidate weights into models/, which is
// gitignored. Weights are never committed. Usage:
//
//   node scripts/spike/models.mjs list <repo>
//   node scripts/spike/models.mjs fetch [candidate...]
//   node scripts/spike/models.mjs report
import { createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HOST = 'https://huggingface.co';
const ROOT = 'models';

/**
 * @typedef {object} Candidate
 * @property {string} id directory under models/
 * @property {string} repo Hugging Face repo
 * @property {string} licence as declared by the repo
 * @property {string} note
 * @property {RegExp} files which paths to take from the repo tree
 */

/** @type {readonly Candidate[]} */
const CANDIDATES = [
  {
    id: 'htdemucs-web',
    repo: 'monteslu/htdemucs-web-onnx',
    licence: 'mit',
    note: 'htdemucs 4-stem, fp16 except Conv/ConvTranspose, 21 chained pieces',
    files: /^(htdemucs_split_manifest\.json|htdemucs_p\d\d\.onnx)$/u,
  },
  {
    id: 'mdx-inst-hq5',
    repo: 'raydotac/AudioSeparatorONNX',
    licence: 'mit (repo); upstream UVR weight provenance undocumented',
    note: 'UVR-MDX-NET-Inst_HQ_5, single file, vocals/instrumental, params in sep_meta',
    files: /^(metadata\.json|UVR-MDX-NET-Inst_HQ_5\.onnx)$/u,
  },
  {
    id: 'whisper-base',
    repo: 'onnx-community/whisper-base',
    licence: 'apache-2.0',
    note: 'whisper-base int8 encoder and merged decoder, same weights on both backends',
    files:
      /^(config\.json|generation_config\.json|preprocessor_config\.json|tokenizer\.json|tokenizer_config\.json|special_tokens_map\.json|added_tokens\.json|normalizer\.json|merges\.txt|vocab\.json|onnx\/(encoder_model_quantized|decoder_model_merged_quantized)\.onnx)$/u,
  },
];

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} -> ${String(response.status)} ${response.statusText}`);
  }
  return response.json();
}

/**
 * @typedef {object} TreeEntry
 * @property {string} path
 * @property {number} size
 */

/**
 * @param {string} repo
 * @returns {Promise<TreeEntry[]>}
 */
async function readTree(repo) {
  const tree = await getJson(`${HOST}/api/models/${repo}/tree/main?recursive=1`);
  if (!Array.isArray(tree)) {
    throw new Error(`unexpected tree for ${repo}`);
  }
  /** @type {TreeEntry[]} */
  const entries = [];
  for (const raw of tree) {
    const entry = /** @type {Record<string, unknown>} */ (raw);
    if (entry['type'] !== 'file') {
      continue;
    }
    const path = typeof entry['path'] === 'string' ? entry['path'] : '';
    const lfs = /** @type {Record<string, unknown> | undefined} */ (entry['lfs']);
    const size =
      typeof lfs?.['size'] === 'number'
        ? lfs['size']
        : typeof entry['size'] === 'number'
          ? entry['size']
          : 0;
    entries.push({ path, size });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * @param {string} repo
 * @param {string} path
 * @param {string} destination
 * @returns {Promise<number>}
 */
async function download(repo, path, destination) {
  const response = await fetch(`${HOST}/${repo}/resolve/main/${path}`);
  if (!response.ok || response.body === null) {
    throw new Error(`${repo}/${path} -> ${String(response.status)} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  return statSync(destination).size;
}

/**
 * @param {Candidate} candidate
 * @returns {Promise<void>}
 */
async function fetchCandidate(candidate) {
  const wanted = (await readTree(candidate.repo)).filter((entry) => candidate.files.test(entry.path));
  if (wanted.length === 0) {
    throw new Error(`no files matched for ${candidate.repo}`);
  }
  const total = wanted.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`${candidate.id}: ${String(wanted.length)} file(s), ${mib(total)} from ${candidate.repo}`);

  for (const entry of wanted) {
    const target = `${ROOT}/${candidate.id}/${entry.path}`;
    const directory = target.slice(0, target.lastIndexOf('/'));
    mkdirSync(directory, { recursive: true });
    const existing = (() => {
      try {
        return statSync(target).size;
      } catch {
        return 0;
      }
    })();
    if (existing > 0 && (entry.size === 0 || existing === entry.size)) {
      console.log(`  have ${entry.path} (${mib(existing)})`);
      continue;
    }
    const written = await download(candidate.repo, entry.path, target);
    console.log(`  got  ${entry.path} (${mib(written)})`);
  }
}

/**
 * @param {string} directory
 * @returns {{ files: number, bytes: number }}
 */
function measure(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) {
      continue;
    }
    files += 1;
    bytes += statSync(`${entry.parentPath}/${entry.name}`).size;
  }
  return { files, bytes };
}

const [, , command = 'report', ...rest] = process.argv;

if (command === 'list') {
  const repo = rest[0];
  if (repo === undefined) {
    throw new Error('list needs a repo, for example: list onnx-community/whisper-base');
  }
  const entries = await readTree(repo);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    console.log(`${mib(entry.size).padStart(10)}  ${entry.path}`);
  }
  console.log(`${String(entries.length)} file(s), ${mib(total)} total`);
} else if (command === 'grab') {
  const [repo, path, destination] = rest;
  if (repo === undefined || path === undefined || destination === undefined) {
    throw new Error('grab needs <repo> <path> <destination-under-models>');
  }
  const target = `${ROOT}/${destination}`;
  mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  console.log(`got ${path} (${mib(await download(repo, path, target))}) -> ${target}`);
} else if (command === 'fetch') {
  const chosen = rest.length > 0 ? CANDIDATES.filter((c) => rest.includes(c.id)) : CANDIDATES;
  if (chosen.length === 0) {
    throw new Error(`no such candidate: ${rest.join(', ')}`);
  }
  for (const candidate of chosen) {
    await fetchCandidate(candidate);
  }
  const { files, bytes } = measure(ROOT);
  console.log(`models/ now holds ${String(files)} file(s), ${mib(bytes)}`);
} else if (command === 'report') {
  for (const candidate of CANDIDATES) {
    console.log(`${candidate.id}\t${candidate.repo}\tlicence ${candidate.licence}\t${candidate.note}`);
  }
  try {
    const { files, bytes } = measure(ROOT);
    console.log(`models/ holds ${String(files)} file(s), ${mib(bytes)}`);
  } catch {
    console.log('models/ does not exist yet');
  }
} else {
  throw new Error(`unknown command: ${command}`);
}
