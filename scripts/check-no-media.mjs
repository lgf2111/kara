#!/usr/bin/env node
// Fails when the index tracks audio, video, model weights or any oversized
// file. Adding licensed media means changing this guard in the same pull
// request, on purpose and in review.
import { sizeOf } from './lib/fs.mjs';
import { listTrackedFiles } from './lib/git.mjs';
import { classifyPath, classifySize } from './lib/media.mjs';

/** @type {string[]} */
const problems = [];
const tracked = listTrackedFiles();

for (const file of tracked) {
  const byPath = classifyPath(file);
  if (byPath !== null) {
    problems.push(`${file}: ${byPath.rule}: ${byPath.detail}`);
    continue;
  }
  const size = sizeOf(file);
  if (size === null) {
    continue; // tracked but not present in this checkout
  }
  const bySize = classifySize(size);
  if (bySize !== null) {
    problems.push(`${file}: ${bySize.rule}: ${bySize.detail}`);
  }
}

if (problems.length > 0) {
  console.error('Files that must not be tracked:');
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log(`media guard clean: ${String(tracked.length)} tracked file(s)`);
}
