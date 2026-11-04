/**
 * What the model is, and where it sits once the extension is packed.
 *
 * Separate from `engine.ts` because everything in the extension needs the
 * sample rate, while only the separation worker should be anywhere near
 * onnxruntime-web. Both paths below are relative to the extension's root, so
 * `chrome.runtime.getURL` turns them into something to fetch; the debug page
 * serves the same two directories from the preview server instead.
 */

export { SAMPLE_RATE, SEGMENT_SAMPLES } from '../../../web/src/separation/htdemucs.ts';

/** Where the graph's pieces sit inside the packed extension. */
export const WEIGHTS_PATH = 'weights/htdemucs-web';

/** Where onnxruntime-web's wasm sits inside it. Ends in a slash. */
export const RUNTIME_PATH = 'ort/';
