import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { headersForPattern, parseHeadersFile } from '../src/security-headers.ts';

const headersFile = fileURLToPath(new URL('../public/_headers', import.meta.url));
const production = headersForPattern(parseHeadersFile(readFileSync(headersFile, 'utf8')), '/*');

describe('parseHeadersFile', () => {
  it('reads blocks, ignores comments and blank lines', () => {
    const blocks = parseHeadersFile(
      ['# comment', '', '/*', '  A: 1', '  B: two: three', '', '/assets/*', '  C: 3'].join('\n'),
    );
    expect(blocks).toEqual([
      { pattern: '/*', headers: { A: '1', B: 'two: three' } },
      { pattern: '/assets/*', headers: { C: '3' } },
    ]);
  });

  it('rejects a header with no path block', () => {
    expect(() => parseHeadersFile('  A: 1')).toThrow(/before any path pattern/u);
  });

  it('rejects a line with no colon', () => {
    expect(() => parseHeadersFile('/*\n  nonsense')).toThrow(/malformed header line/u);
  });
});

describe('production headers', () => {
  it('asks for cross-origin isolation, which SharedArrayBuffer needs', () => {
    expect(production['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(production['Cross-Origin-Embedder-Policy']).toBe('require-corp');
  });

  it('confines network access to this origin, so audio cannot be sent anywhere', () => {
    const policy = production['Content-Security-Policy'] ?? '';
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('*');
  });

  it('denies the camera and location, and keeps the microphone first-party', () => {
    expect(production['Permissions-Policy']).toBe('camera=(), geolocation=(), microphone=(self)');
  });
});
