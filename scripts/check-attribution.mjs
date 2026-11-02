#!/usr/bin/env node
// Fails when commit metadata or tracked text mentions the tools that produced
// it. Scans the pull request's commit range in CI, otherwise HEAD only.
import { findAttribution, isExcludedFromContentScan } from './lib/attribution.mjs';
import { readTextFile } from './lib/fs.mjs';
import { listTrackedFiles, readCommits, revisionExists } from './lib/git.mjs';

/** Text files above this size are skipped; nothing legitimate here is bigger. */
const MAX_SCANNED_BYTES = 1024 * 1024;

/**
 * @returns {{ label: string, revisionArgs: string[] }}
 */
function resolveRange() {
  const flag = process.argv.indexOf('--range');
  if (flag !== -1) {
    const range = process.argv[flag + 1];
    if (range === undefined || range.startsWith('-')) {
      throw new Error('--range needs a value, for example: --range origin/main..HEAD');
    }
    return { label: range, revisionArgs: [range] };
  }
  const baseRef = process.env['GITHUB_BASE_REF'] ?? '';
  if (baseRef !== '' && revisionExists(`origin/${baseRef}`)) {
    const range = `origin/${baseRef}..HEAD`;
    return { label: range, revisionArgs: [range] };
  }
  return { label: 'HEAD', revisionArgs: ['-1', 'HEAD'] };
}

/** @type {string[]} */
const problems = [];

const { label, revisionArgs } = resolveRange();
const commits = readCommits(revisionArgs);
for (const commit of commits) {
  /** @type {readonly [string, string][]} */
  const fields = [
    ['message', commit.message],
    ['author', `${commit.authorName} <${commit.authorEmail}>`],
    ['committer', `${commit.committerName} <${commit.committerEmail}>`],
  ];
  for (const [field, value] of fields) {
    for (const finding of findAttribution(value)) {
      problems.push(`commit ${commit.sha.slice(0, 8)} ${field}: ${finding.id}: ${finding.excerpt}`);
    }
  }
}

let scannedFiles = 0;
for (const file of listTrackedFiles()) {
  if (isExcludedFromContentScan(file)) {
    continue;
  }
  const contents = readTextFile(file, MAX_SCANNED_BYTES);
  if (contents === null) {
    continue;
  }
  scannedFiles += 1;
  for (const finding of findAttribution(contents)) {
    problems.push(`${file}:${String(finding.line)}: ${finding.id}: ${finding.excerpt}`);
  }
}

if (problems.length > 0) {
  console.error('Tool attribution found. This repository records what changed, not what typed it:');
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `attribution guard clean: ${String(commits.length)} commit(s) in ${label}, ${String(scannedFiles)} text file(s)`,
  );
}
