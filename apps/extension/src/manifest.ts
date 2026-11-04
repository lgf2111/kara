/**
 * The manifest, built rather than written.
 *
 * Two reasons it is a function. The host and the content script have to match
 * the same list of sites or the two halves disagree about where the extension
 * works, and a list written twice in JSON eventually is. And the debug page is
 * served from localhost, which has no business in a manifest anybody installs:
 * the build decides.
 *
 * Nothing in here is loaded over the network, which is why there are no
 * `web_accessible_resources` and no remote origins anywhere: the weights, the
 * ONNX runtime, the worklets and the separation worker are all packed files
 * read from extension contexts, and `wasm-unsafe-eval` is the only thing the
 * default policy is missing.
 */

export interface ManifestOptions {
  /**
   * Also match `http://localhost/*`, so the extension can be pointed at the
   * debug page in `test/`. Off for anything anyone would install.
   */
  readonly localhost?: boolean;
  readonly version?: string;
}

export interface Manifest {
  readonly manifest_version: 3;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly minimum_chrome_version: string;
  readonly permissions: readonly string[];
  readonly host_permissions: readonly string[];
  readonly action: { readonly default_title: string };
  readonly background: { readonly service_worker: string; readonly type: 'module' };
  readonly content_scripts: readonly {
    readonly matches: readonly string[];
    readonly js: readonly string[];
    readonly run_at: string;
    readonly all_frames: boolean;
  }[];
  readonly content_security_policy: { readonly extension_pages: string };
}

const YOUTUBE = 'https://www.youtube.com/*';
const LOCALHOST = 'http://localhost/*';

export function buildManifest(options: ManifestOptions = {}): Manifest {
  const matches = options.localhost === true ? [YOUTUBE, LOCALHOST] : [YOUTUBE];
  return {
    manifest_version: 3,
    name: 'Kara live',
    version: options.version ?? '0.1.0',
    description:
      "Takes the vocal out of the tab's own audio as it plays, on this device, " +
      'and plays the result back on a delay.',
    // Offscreen documents arrived in 109; this needs a WebGPU adapter with
    // shader-f16, which is a much later Chrome in practice.
    minimum_chrome_version: '116',
    permissions: ['tabCapture', 'offscreen', 'activeTab', 'scripting', 'storage'],
    host_permissions: matches,
    action: { default_title: 'Kara: capture this tab' },
    background: { service_worker: 'background.js', type: 'module' },
    // Not a module: Chrome runs content scripts as classic scripts, so this
    // one is built as its own self-contained file.
    content_scripts: [
      { matches, js: ['content.js'], run_at: 'document_idle', all_frames: false },
    ],
    content_security_policy: {
      // 'wasm-unsafe-eval' is what lets the ONNX runtime compile its wasm.
      // Everything else is the Manifest V3 default, spelled out.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };
}
