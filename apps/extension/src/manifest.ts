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
  readonly action: {
    readonly default_title: string;
    /** The popup is the one window that exists with no video playing. */
    readonly default_popup: string;
  };
  readonly background: { readonly service_worker: string; readonly type: 'module' };
  readonly content_scripts: readonly {
    readonly matches: readonly string[];
    readonly js: readonly string[];
    readonly run_at: string;
    readonly all_frames: boolean;
    /** `MAIN` for the script that has to live in the page's own world. */
    readonly world?: 'MAIN' | 'ISOLATED';
  }[];
  readonly content_security_policy: { readonly extension_pages: string };
}

const YOUTUBE = 'https://www.youtube.com/*';
const GOOGLEVIDEO = 'https://*.googlevideo.com/*';
const LOCALHOST = 'http://localhost/*';
const DUET_HELPER = 'http://127.0.0.1/*';

export function buildManifest(options: ManifestOptions = {}): Manifest {
  const matches = options.localhost === true ? [YOUTUBE, LOCALHOST] : [YOUTUBE];
  return {
    manifest_version: 3,
    name: 'Kara',
    version: options.version ?? '0.1.0',
    description:
      "Takes the vocal out of the video you're watching: the audio is read once, " +
      'separated on this device, and played back in place of the original sound.',
    // Offscreen documents arrived in 109; MAIN-world content scripts in 111.
    // This needs a WebGPU adapter with shader-f16, which is a much later
    // Chrome in practice.
    minimum_chrome_version: '116',
    permissions: ['offscreen', 'storage', 'audioCapture'],
    // The audio streams YouTube serves live on googlevideo.com, so reading one
    // is a host permission; it is read by extension contexts only.
    host_permissions: [...matches, GOOGLEVIDEO, DUET_HELPER],
    action: { default_title: 'Kara: separate this video', default_popup: 'popup.html' },
    background: { service_worker: 'background.js', type: 'module' },
    // Not modules: Chrome runs content scripts as classic scripts, so each is
    // built as its own self-contained file. `stream-info.js` runs in the
    // page's own world, at document_start, so it can watch for the player
    // response however the page comes by it.
    content_scripts: [
      { matches, js: ['content.js'], run_at: 'document_idle', all_frames: false },
      {
        matches,
        js: ['stream-info.js'],
        run_at: 'document_start',
        all_frames: false,
        world: 'MAIN',
      },
    ],
    content_security_policy: {
      // 'wasm-unsafe-eval' is what lets the ONNX runtime compile its wasm.
      // Everything else is the Manifest V3 default, spelled out.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };
}
