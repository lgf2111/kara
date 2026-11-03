/**
 * What the page and the lyrics worker say to each other.
 *
 * One frame at a time, request and reply: OCR on a frame takes about half a
 * second, which is long enough that the page wants it off the main thread, and
 * short enough that there is nothing to gain from a queue.
 *
 * Recognised text crosses this boundary. It stays on the device, and it never
 * reaches a log or the console.
 */

export interface OpenMessage {
  readonly kind: 'open';
}

export interface ReadMessage {
  readonly kind: 'read';
  readonly id: number;
  /** One prepared crop, as a PNG. */
  readonly image: Blob;
}

export type LyricsRequest = OpenMessage | ReadMessage;

export interface ReadyMessage {
  readonly kind: 'ready';
}

export interface TextMessage {
  readonly kind: 'text';
  readonly id: number;
  readonly text: string;
  /** Tesseract's mean confidence for the crop, 0 to 100. */
  readonly confidence: number;
}

export interface FailedMessage {
  readonly kind: 'failed';
  readonly stage: string;
  readonly error: string;
}

export type LyricsMessage = ReadyMessage | TextMessage | FailedMessage;
