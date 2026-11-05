import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

import { buildManifest } from './src/manifest.ts';

/**
 * Four builds into one `dist/`, because the pieces of an extension are not all
 * the same kind of file.
 *
 * - `pages` is the ordinary one: the offscreen document, the toolbar popup,
 *   the service worker, the debug page and the separation worker, as ES
 *   modules with shared chunks, plus the manifest.
 * - `stem-player` is one file, on purpose. A worklet is handed to `addModule`
 *   as a module script, and static imports inside one are not something to
 *   rely on, so it is built from a single entry: rollup then has nothing to
 *   split and the output cannot contain an import. A guard below fails the
 *   build if one ever does.
 * - `content` and `stream-info` are IIFEs, because Chrome runs content scripts
 *   as classic scripts and a module would not load at all. They are two builds
 *   rather than one because the IIFE format refuses a second input, and
 *   because the two are different worlds anyway: `content` is isolated code
 *   with the Chrome API, `stream-info` is the page's own world with neither.
 *
 * `scripts/build-extension.mjs` runs all four and then fills in the weights
 * and the ONNX runtime. The target comes from the environment rather than from
 * `--mode` so that every build is a production build: the separation engine
 * reads `import.meta.env.PROD` to decide how to load the runtime's wasm, and a
 * custom mode would quietly turn that off.
 */

type Target = 'pages' | 'stem-player' | 'content' | 'stream-info';

const TARGETS: readonly Target[] = ['pages', 'stem-player', 'content', 'stream-info'];

function target(): Target {
  const asked = process.env['KARA_EXT_TARGET'] ?? 'pages';
  if (!TARGETS.includes(asked as Target)) {
    throw new Error(`KARA_EXT_TARGET is ${asked}, which is not one of ${TARGETS.join(', ')}`);
  }
  return asked as Target;
}

function here(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const CONTENT_TYPES = new Map([
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
]);

/**
 * Serves `fixtures/generated` read-only to the debug page.
 *
 * The fixtures are synthesised by `scripts/spike/make-fixtures.mjs`, are
 * gitignored, and are the only media this repository ever sees. Nothing here
 * reaches a production build: the packed extension has no server and no
 * fixtures in it.
 */
function serveFixtures(): Plugin {
  const root = `${repoRoot}fixtures/generated`;
  const handle = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const asked = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/').replace(
      /^\/+/u,
      '',
    );
    if (asked === '' || asked.includes('..')) {
      next();
      return;
    }
    const path = `${root}/${asked}`;
    let size: number;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) {
        next();
        return;
      }
      size = stats.size;
    } catch {
      next();
      return;
    }
    const extension = path.slice(path.lastIndexOf('.'));
    response.setHeader('content-type', CONTENT_TYPES.get(extension) ?? 'application/octet-stream');
    response.setHeader('cache-control', 'no-cache');
    // Range requests, because a media element that cannot seek is not a
    // fixture anybody can test a seek with. Chrome asks for bytes; without
    // this it reports `seekable` as [0, 0] and a `currentTime` write snaps
    // back to the start.
    response.setHeader('accept-ranges', 'bytes');
    const range = request.headers.range;
    const ranged = range === undefined ? null : /^bytes=(\d*)-(\d*)$/u.exec(range);
    if (ranged !== null) {
      const start = ranged[1] === '' ? 0 : Number(ranged[1]);
      const end = ranged[2] === '' ? size - 1 : Math.min(Number(ranged[2]), size - 1);
      if (!Number.isFinite(start) || start < 0 || start > end) {
        response.statusCode = 416;
        response.setHeader('content-range', `bytes */${String(size)}`);
        response.end();
        return;
      }
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${String(start)}-${String(end)}/${String(size)}`);
      response.setHeader('content-length', String(end - start + 1));
      createReadStream(path, { start, end }).pipe(response);
      return;
    }
    response.setHeader('content-length', String(size));
    createReadStream(path).pipe(response);
  };

  return {
    name: 'kara-serve-fixtures',
    configureServer(server) {
      server.middlewares.use('/fixtures', handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/fixtures', handle);
    },
  };
}

function emitManifest(): Plugin {
  return {
    name: 'kara-extension-manifest',
    apply: 'build',
    generateBundle() {
      const manifest = buildManifest({
        localhost: process.env['KARA_EXT_LOCALHOST'] === '1',
      });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

/** A worklet with an import in it would fail to load, silently and at runtime. */
function selfContained(): Plugin {
  return {
    name: 'kara-worklet-self-contained',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && /^\s*import[\s{*'"]/mu.test(chunk.code)) {
          throw new Error(`${name} came out with an import in it, which a worklet cannot have`);
        }
      }
    },
  };
}

export default defineConfig(() => {
  const which = target();
  const shared = {
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    worker: { format: 'es' as const },
  };

  if (which === 'pages') {
    return {
      ...shared,
      plugins: [serveFixtures(), emitManifest()],
      build: {
        target: 'es2022',
        outDir: 'dist',
        emptyOutDir: true,
        // The polyfill vite injects for module preloading touches `document`,
        // which a service worker does not have. Nothing here is loaded over a
        // network, so there is nothing for preloading to win either.
        modulePreload: false as const,
        rollupOptions: {
          input: {
            offscreen: here('offscreen.html'),
            popup: here('popup.html'),
            background: here('src/background.ts'),
            page: here('test/page.html'),
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
          },
        },
      },
    };
  }

  if (which === 'content' || which === 'stream-info') {
    // Two classic scripts into two files. They cannot share one build: the
    // IIFE format refuses a second input, and they must not share a file
    // anyway — `content.js` is isolated-world code with the Chrome API, and
    // `stream-info.js` is the page's own world with neither.
    const entry = which === 'content' ? 'src/content.ts' : 'src/stream/stream-info.ts';
    return {
      ...shared,
      build: {
        target: 'es2022',
        outDir: 'dist',
        emptyOutDir: false,
        rollupOptions: {
          input: here(entry),
          output: { format: 'iife' as const, entryFileNames: `${which}.js` },
        },
      },
    };
  }

  const entry = 'src/worklets/stem-player.worklet.ts';
  return {
    ...shared,
    plugins: [selfContained()],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: false,
      rollupOptions: {
        input: here(entry),
        output: { format: 'es' as const, entryFileNames: 'stem-player.js' },
      },
    },
  };
});
