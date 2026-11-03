/**
 * Containers that hold audio or video. No copyrighted material may enter this
 * repository, and synthesised fixtures are generated on demand instead of
 * committed, so a tracked file with one of these extensions is always a bug.
 *
 * `.ts` is deliberately absent: it collides with TypeScript. Commit MPEG
 * transport streams as `.m2ts` if the need ever arises.
 */
export const MEDIA_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.alac',
  '.amr',
  '.ape',
  '.au',
  '.avi',
  '.caf',
  '.flac',
  '.flv',
  '.m2ts',
  '.m4a',
  '.m4b',
  '.m4v',
  '.mka',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.oga',
  '.ogg',
  '.ogv',
  '.opus',
  '.ra',
  '.wav',
  '.webm',
  '.wma',
  '.wmv',
]);

/** Weights are fetched on first use and cached in OPFS, never committed. */
export const MODEL_WEIGHT_EXTENSIONS = new Set([
  '.bin',
  '.ckpt',
  '.gguf',
  '.h5',
  '.onnx',
  '.onnx_data',
  '.pb',
  '.pt',
  '.pth',
  '.safetensors',
  '.tflite',
]);

/**
 * Nothing legitimate in a browser-only project needs to be this big. The cap
 * catches renamed media and vendored binaries that slip past the extension
 * list. Raising it needs a reason in the pull request.
 */
export const MAX_TRACKED_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Lowercased extension including the dot, or '' for dotfiles and names without
 * an extension.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function extensionOf(filePath) {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * @typedef {object} Violation
 * @property {string} rule
 * @property {string} detail
 */

/**
 * @param {string} filePath
 * @returns {Violation | null}
 */
export function classifyPath(filePath) {
  const extension = extensionOf(filePath);
  if (MEDIA_EXTENSIONS.has(extension)) {
    return { rule: 'media', detail: `${extension} is an audio or video container` };
  }
  if (MODEL_WEIGHT_EXTENSIONS.has(extension)) {
    return { rule: 'model-weights', detail: `${extension} looks like model weights` };
  }
  return null;
}

/**
 * @param {number} bytes
 * @returns {Violation | null}
 */
export function classifySize(bytes) {
  if (bytes <= MAX_TRACKED_FILE_BYTES) {
    return null;
  }
  return {
    rule: 'oversized',
    detail: `${String(Math.round(bytes / 1024))} KiB exceeds the ${String(MAX_TRACKED_FILE_BYTES / 1024)} KiB cap`,
  };
}
