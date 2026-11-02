import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const hookPath = fileURLToPath(new URL('../../.githooks/commit-msg', import.meta.url));

describe('commit-msg hook', () => {
  it('is a shell script that delegates to the checker', () => {
    const contents = readFileSync(hookPath, 'utf8');
    expect(contents.startsWith('#!/bin/sh')).toBe(true);
    expect(contents).toContain('scripts/check-commit-message.mjs');
  });

  it('is committed with the executable bit, or git will not run it', () => {
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
  });
});
