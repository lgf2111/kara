import { createReadStream, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { headersForPattern, parseHeadersFile } from './src/security-headers.ts';

const headersFile = fileURLToPath(new URL('./public/_headers', import.meta.url));
const production = headersForPattern(parseHeadersFile(readFileSync(headersFile, 'utf8')), '/*');

// The dev server injects inline scripts for hot reload, which the production
// Content-Security-Policy forbids, so dev gets the isolation headers only.
// `vite preview` serves the built output and gets the full production set.
const isolationOnly = Object.fromEntries(
  Object.entries(production).filter(([name]) => name.toLowerCase().startsWith('cross-origin-')),
);

const CONTENT_TYPES = new Map([
  ['.json', 'application/json'],
  ['.onnx', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.mjs', 'text/javascript'],
  ['.js', 'text/javascript'],
  ['.jsep', 'application/octet-stream'],
  ['.wav', 'audio/wav'],
]);

/** Size of a regular file, or null for anything else. */
function fileSize(path: string): number | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/**
 * Serves one directory read-only under a URL prefix, for the dev server only.
 * Nothing here reaches the production build, and the spike loads every byte
 * from its own origin, so the production CSP needs no weights exception.
 */
function serveDirectory(prefix: string, root: string): Plugin {
  return {
    name: `kara-serve-${prefix.replaceAll('/', '')}`,
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(prefix, (request, response, next) => {
        const relative = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/u, '');
        if (relative === '' || relative.includes('..')) {
          next();
          return;
        }
        const path = `${root}/${relative}`;
        const size = fileSize(path);
        if (size === null) {
          next();
          return;
        }
        const extension = path.slice(path.lastIndexOf('.'));
        response.setHeader('content-type', CONTENT_TYPES.get(extension) ?? 'application/octet-stream');
        response.setHeader('content-length', String(size));
        response.setHeader('cache-control', 'no-cache');
        // The page is cross-origin isolated, and onnxruntime-web loads its
        // emscripten glue as a nested worker script. Chrome then requires the
        // response itself to assert COEP and CORP, reporting
        // CoepFrameResourceNeedsCoepHeader otherwise. Without these the fetch
        // is blocked, InferenceSession.create never settles, and the renderer
        // sits idle forever instead of raising an error.
        response.setHeader('cross-origin-embedder-policy', 'require-corp');
        response.setHeader('cross-origin-resource-policy', 'cross-origin');
        response.setHeader('access-control-allow-origin', '*');
        createReadStream(path).pipe(response);
      });
    },
  };
}

/** Nicer to type than the .html, and these only exist in dev. */
function devRoutes(): Plugin {
  return {
    name: 'kara-dev-routes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === '/spike' || request.url === '/spike/') {
          request.url = '/spike.html';
        }
        if (request.url === '/pipeline' || request.url === '/pipeline/') {
          request.url = '/pipeline.html';
        }
        next();
      });
    },
  };
}

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const ortDist = require.resolve('onnxruntime-web').replace(/\/[^/]+$/u, '');
// transformers.js pins its own onnxruntime-web build, and its wasm must match
// that version rather than ours.
const hfOrtDist = require
  .resolve('onnxruntime-web', { paths: [require.resolve('@huggingface/transformers')] })
  .replace(/\/[^/]+$/u, '');

export default defineConfig({
  plugins: [
    react(),
    devRoutes(),
    // Weights live at a same-origin path, which is the arrangement M1 chose:
    // production will serve /weights/* from R2 behind the same host, so no CSP
    // exception is ever needed. In dev it comes from the gitignored models/.
    serveDirectory('/weights', `${repoRoot}models`),
    serveDirectory('/spike-ort', ortDist),
    serveDirectory('/spike-hf-ort', hfOrtDist),
    // Synthesised fixtures only, for the Playwright run. Gitignored, and the
    // route does not exist in a production build.
    serveDirectory('/spike-fixtures', `${repoRoot}fixtures/generated`),
  ],
  server: { headers: isolationOnly },
  preview: { headers: production },
  optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Only the real app ships. spike.html and everything it imports stay out
    // of the production build.
    rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) },
  },
});
