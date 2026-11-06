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

/**
 * The separation model, as the cache knows it.
 *
 * It is part of every cache key: a different model is different stems even
 * when the video is the same. Kept as its own name here so the engine does not
 * import the web app's runner (and onnxruntime with it) just to spell it.
 */
export const SEPARATION_MODEL_VERSION = 'htdemucs-web';

/** Where the graph's pieces sit inside the packed extension. */
export const WEIGHTS_PATH = 'weights/htdemucs-web';

/** Where onnxruntime-web's wasm sits inside it. Ends in a slash. */
export const RUNTIME_PATH = 'ort/';
