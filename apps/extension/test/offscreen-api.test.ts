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
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
  const source = stripComments(
    readFileSync(new URL('../src/offscreen.ts', import.meta.url), 'utf8'),
  );
  const engine = stripComments(
    readFileSync(new URL('../src/offscreen/engine.ts', import.meta.url), 'utf8'),
  );

  it('does not use chrome.storage', () => {
    expect(source).not.toMatch(/chrome\.storage/u);
  });

  it('does not use chrome.storage in the engine either', () => {
    expect(engine).not.toMatch(/chrome\.storage/u);
  });

  it('does not import the module that does', () => {
    expect(source).not.toMatch(/settings-store|duet-store/u);
  });
});
