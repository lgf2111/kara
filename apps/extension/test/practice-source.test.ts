import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Practice must analyse the separated vocal stem and nothing else.
 *
 * The engine keeps eight channels and mixes some of them for the song card;
 * only the vocal pair is allowed to reach the practice worker. The engine is
 * an audio graph and cannot be built in node, so this guard reads the source
 * the same way the offscreen test does: comments may describe the stems, only
 * code can route the wrong one in.
 */
function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

describe('practice analysis source', () => {
  const engine = source('../src/offscreen/engine.ts');
  const worker = source('../src/offscreen/practice.worker.ts');

  it('fills the practice source from the separated vocal pair only', () => {
    const start = engine.indexOf('const vocalLeft = channels[6];');
    const end = engine.indexOf('const buffers = analysisBuffers;', start);
    const block = start >= 0 && end > start ? engine.slice(start, end) : '';

    expect(block).toContain('const vocalLeft = channels[6];');
    expect(block).toContain('const vocalRight = channels[7];');
    expect(block).toMatch(/vocalsMono\[at\] =/u);
    expect(block).not.toMatch(/channels\[[0-5]\]/u);
  });

  it('hands that vocal copy to the practice session', () => {
    expect(engine).toMatch(/const copy = cached === null \? vocalsMono\.slice\(\) : null;/u);
    expect(engine).toMatch(/samples: copy,/u);
    expect(engine).not.toMatch(/samples:\s*(?:harmonic|percussive|analysisInputs)/u);
  });

  it('analyses the samples the command carries', () => {
    expect(worker).toMatch(/analyseMelody\(command\.samples, command\.sampleRate/u);
  });
});
