import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { headersForPattern, parseHeadersFile } from './src/security-headers.ts';

const headersFile = fileURLToPath(new URL('./public/_headers', import.meta.url));
const production = headersForPattern(parseHeadersFile(readFileSync(headersFile, 'utf8')), '/*');

// The dev server injects inline scripts for hot reload, which the production
// Content-Security-Policy forbids, so dev gets the isolation headers only.
// `vite preview` serves the built output and gets the full production set.
const isolationOnly = Object.fromEntries(
  Object.entries(production).filter(([name]) => name.toLowerCase().startsWith('cross-origin-')),
);

export default defineConfig({
  plugins: [react()],
  server: { headers: isolationOnly },
  preview: { headers: production },
  build: { target: 'es2022' },
});
