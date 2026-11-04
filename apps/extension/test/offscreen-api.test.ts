import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * An offscreen document has `chrome.runtime` and nothing else: no
 * `chrome.storage`, no `chrome.tabs`. Tests run in node and a page on
 * localhost has all of them, so only reading the source can catch the one
 * that is not there. The setting reaches the document as a command instead.
 */
describe('offscreen document', () => {
  // Comments are free to say what the document lacks; only code can break.
  const source = readFileSync(new URL('../src/offscreen.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');

  it('does not use chrome.storage', () => {
    expect(source).not.toMatch(/chrome\.storage/u);
  });

  it('does not import the module that does', () => {
    expect(source).not.toMatch(/settings-store/u);
  });
});
