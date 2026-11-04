import {
  bisect,
  compare,
  environment,
  nodes,
  report,
  sweep,
  type BisectOptions,
  type SweepOptions,
} from './diagnostics/webgpu-bisect.ts';

/**
 * The diagnostic page behind `scripts/spike/webgpu-bisect.mjs`. Dev only: it is
 * not in the production build's entry points and its route exists only on the
 * Vite dev server.
 *
 * Everything it does is reachable from `window.karaBisect`, so the Playwright
 * driver and the buttons below take the same path.
 */

const api = { environment, nodes, compare, bisect, sweep, report };

(globalThis as unknown as Record<string, unknown>)['karaBisect'] = api;

const root = document.getElementById('root');
const log = document.createElement('pre');
log.id = 'bisect-log';
log.style.whiteSpace = 'pre-wrap';

function write(line: string): void {
  log.textContent = `${log.textContent ?? ''}${line}\n`;
}

function button(label: string, run: () => Promise<unknown>): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', () => {
    element.disabled = true;
    write(`\n--- ${label}`);
    void run()
      .then((value) => {
        write(JSON.stringify(value, null, 2));
      })
      .catch((cause: unknown) => {
        write(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
      })
      .finally(() => {
        element.disabled = false;
      });
  });
  return element;
}

/** The piece and seed the buttons use. The driver passes its own. */
const DEFAULTS: BisectOptions & SweepOptions = { piece: 'htdemucs_p00.onnx', seed: 1337 };

if (root !== null) {
  const heading = document.createElement('h1');
  heading.textContent = 'WebGPU bisect';
  const blurb = document.createElement('p');
  blurb.textContent =
    'Development page. It loads one piece of the htdemucs chain on WASM and on WebGPU, ' +
    'feeds both the same synthesised segment, and reports where they stop agreeing. ' +
    'No file of yours is read and nothing leaves the tab.';

  const controls = document.createElement('p');
  controls.append(
    button('environment', () => environment()),
    button('nodes', () => nodes(DEFAULTS)),
    button('compare', () => compare(DEFAULTS)),
    button('bisect', () => bisect(DEFAULTS)),
    button('options', () => sweep(DEFAULTS)),
    button('full report', () => report(DEFAULTS)),
  );
  root.append(heading, blurb, controls, log);
}

const hook = (globalThis as unknown as Record<string, unknown>)['karaPhase'];
console.log('[bisect] page-ready', { crossOriginIsolated });
if (typeof hook === 'function') {
  (hook as (name: string, detail?: unknown) => void)('page-ready', { crossOriginIsolated });
}
