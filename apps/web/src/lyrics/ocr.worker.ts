/// <reference lib="webworker" />
import { OEM, PSM, createWorker, type Worker as OcrEngine } from 'tesseract.js';

import type { FailedMessage, LyricsRequest, ReadyMessage, TextMessage } from './protocol.ts';

/**
 * Tesseract, one crop at a time, off the main thread.
 *
 * Every byte it needs comes from this origin: the worker script and core wasm
 * from node_modules, the English traineddata from the gitignored models
 * folder, all served by the routes in `apps/web/vite.config.ts`. Left to
 * itself tesseract.js fetches all three from jsdelivr, which `connect-src
 * 'self'` forbids and the legal line does not allow. See
 * `docs/lyrics-ocr.md` for where the traineddata comes from.
 */

const ASSETS = '/tesseract';

/**
 * tesseract.js resolves these three against `window.location`, which a worker
 * has not got, so it leaves whatever it is given alone. A root-relative path
 * would then be resolved against its own worker URL and fail, so the absolute
 * URL is built here.
 */
function asset(path: string): string {
  return new URL(path, self.location.origin).href;
}

/**
 * A crop is a band of a frame holding a line or two, not a page, so page
 * segmentation has nothing to work out and only gets in the way. The node
 * spike used AUTO because it fed OCR whole frames.
 */
const PAGE_SEGMENTATION = PSM.SINGLE_BLOCK;

let engine: OcrEngine | null = null;

function post(message: ReadyMessage | TextMessage | FailedMessage): void {
  self.postMessage(message);
}

function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.includes('traineddata')
    ? `${text} (put eng.traineddata in models/tessdata, see docs/lyrics-ocr.md)`
    : text;
}

async function open(): Promise<void> {
  if (engine !== null) {
    return;
  }
  engine = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: asset(`${ASSETS}/worker.min.js`),
    corePath: asset(`${ASSETS}/core/`),
    langPath: asset(`${ASSETS}/tessdata`),
    gzip: false,
    // Loaded straight rather than through a blob, so the one script tag this
    // needs is covered by worker-src 'self'.
    workerBlobURL: false,
    // No second copy in IndexedDB: the bytes come from this origin already,
    // and the library's storage figure should only count the user's songs.
    cacheMethod: 'none',
    // Progress messages carry no text, but nothing from OCR goes to the
    // console at all, so there is one less way for a lyric to escape.
    logger: () => {},
    // tesseract.js reports a language or core that will not load here and
    // leaves its own promise pending for ever, so this is the only way the
    // page hears about it.
    errorHandler: (cause: unknown) => {
      post({ kind: 'failed', stage: 'loading tesseract', error: errorText(cause) });
    },
  });
  await engine.setParameters({
    tessedit_pageseg_mode: PAGE_SEGMENTATION,
    // An upscaled crop is not a scanned page. Saying so stops tesseract
    // guessing a resolution from the pixel count and warning about it.
    user_defined_dpi: '300',
  });
}

async function read(id: number, image: Blob): Promise<void> {
  const active = engine;
  if (active === null) {
    throw new Error('the lyrics worker was asked to read before it was opened');
  }
  const { data } = await active.recognize(image, {}, { text: true });
  post({ kind: 'text', id, text: data.text, confidence: data.confidence });
}

// One job at a time, in the order they arrived. The chain never rejects, so a
// frame tesseract chokes on does not take the rest of the video with it.
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<LyricsRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      if (request.kind === 'open') {
        await open();
        post({ kind: 'ready' });
        return;
      }
      await read(request.id, request.image);
    } catch (cause) {
      post({ kind: 'failed', stage: request.kind, error: errorText(cause) });
    }
  });
});
