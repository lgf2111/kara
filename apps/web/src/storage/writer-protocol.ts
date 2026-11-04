/**
 * What the page says to the writer worker. One file per message: the worker
 * exists only because Safari's sync access handles cannot be opened from the
 * page, so it has nothing to decide.
 */

export interface WriteRequest {
  readonly kind: 'write';
  readonly id: number;
  readonly path: string;
  /**
   * The bytes. A Blob survives structured cloning by reference rather than by
   * copy, so handing over a kept video costs nothing and its bytes never pass
   * through either heap: the worker reads it back a slice at a time.
   */
  readonly blob: Blob;
}

export type WriteReply =
  | { readonly kind: 'written'; readonly id: number }
  | { readonly kind: 'failed'; readonly id: number; readonly error: string };
