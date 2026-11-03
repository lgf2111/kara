#!/usr/bin/env node
// Backs the commit-msg hook. Takes the path to the pending commit message.
import { readFileSync } from 'node:fs';

import { findAttribution } from './lib/attribution.mjs';

const messagePath = process.argv[2];
if (messagePath === undefined) {
  console.error('usage: node scripts/check-commit-message.mjs <path-to-message>');
  process.exit(2);
}

const message = readFileSync(messagePath, 'utf8')
  .split('\n')
  .filter((line) => !line.startsWith('#'))
  .join('\n');

const findings = findAttribution(message);
if (findings.length > 0) {
  console.error('Commit rejected: the message mentions the tools behind the change.');
  for (const finding of findings) {
    console.error(`  line ${String(finding.line)}: ${finding.id}: ${finding.excerpt}`);
  }
  process.exit(1);
}
