#!/usr/bin/env node
// Hooks live in .githooks so they are reviewed like any other file. Git only
// runs them once core.hooksPath points there.
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, statSync } from 'node:fs';

const HOOKS_DIR = '.githooks';

for (const name of readdirSync(HOOKS_DIR)) {
  if (name.startsWith('.')) {
    continue;
  }
  const path = `${HOOKS_DIR}/${name}`;
  const current = statSync(path).mode & 0o777;
  const wanted = current | 0o111;
  if (current !== wanted) {
    chmodSync(path, wanted);
  }
  console.log(`executable: ${path}`);
}

const result = spawnSync('git', ['config', 'core.hooksPath', HOOKS_DIR], { encoding: 'utf8' });
if (result.status === 0) {
  console.log(`core.hooksPath = ${HOOKS_DIR} (undo with: git config --unset core.hooksPath)`);
} else {
  console.error(`could not set core.hooksPath: ${result.stderr.trim()}`);
  process.exitCode = 1;
}
