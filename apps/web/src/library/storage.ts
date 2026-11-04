import type { Store } from '../storage/store.ts';
import type { SongRecord, SongStore, SourceKind } from './songs.ts';

/**
 * What the library occupies, and how a song is taken away again. Browser-free
 * on purpose: everything here goes through {@link Store}, so it can be tested
 * against the in-memory store.
 */

/** Where a song's own bytes are kept, inside the directory the job owns. */
export function sourcePathFor(directory: string, fileName: string): string {
  const match = /\.[a-z0-9]{1,5}$/iu.exec(fileName);
  return `${directory}/source${match === null ? '' : match[0].toLowerCase()}`;
}

/**
 * Containers whose type a media element wants told. The browser sniffs the
 * bytes too, but a blob with no type at all is refused outright, and the
 * record keeps the extension rather than the type the file arrived with.
 */
const MEDIA_TYPES = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['mkv', 'video/x-matroska'],
  ['webm', 'video/webm'],
  ['avi', 'video/x-msvideo'],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['wav', 'audio/wav'],
  ['aiff', 'audio/aiff'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/ogg'],
]);

/**
 * The type to label a kept file with. An extension nobody recognises falls
 * back on the kind the record says it is, which is enough for the element to
 * agree to sniff the bytes.
 */
export function mediaTypeFor(path: string, kind: SourceKind = 'video'): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MEDIA_TYPES.get(extension) ?? (kind === 'audio' ? 'audio/mpeg' : 'video/mp4');
}

/** The same, for a path known to hold a video. */
export function videoTypeFor(path: string): string {
  return mediaTypeFor(path, 'video');
}

/** Read in pieces this big, so a long video is never one allocation. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * A kept source file, back out of the store as a blob a video element can
 * open.
 *
 * Read in chunks rather than whole: a four-minute video is tens of megabytes,
 * and the browser is free to keep a blob built from pieces on disk, which one
 * big typed array would not be.
 */
export async function sourceBlob(
  store: Store,
  path: string,
  type: string,
  chunkBytes = CHUNK_BYTES,
): Promise<Blob> {
  const size = await store.sizeOf(path);
  if (size === null) {
    throw new Error(`the file kept for this song is gone from ${path}`);
  }
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < size; offset += chunkBytes) {
    const chunk = await store.readBytes(path, offset, Math.min(chunkBytes, size - offset));
    if (chunk === null || chunk.byteLength === 0) {
      throw new Error(`${path} ended after ${String(offset)} of ${String(size)} bytes`);
    }
    pieces.push(chunk as Uint8Array<ArrayBuffer>);
  }
  return new Blob(pieces, { type });
}

/**
 * A kept source file for something that will stream it, labelled with the
 * type a media element wants told.
 *
 * Unlike {@link sourceBlob} this never reads a byte: the store hands back a
 * handle to what is on disk, and `slice` relabels it without copying, so the
 * player can hold a whole song open for nothing. Use the chunked read only
 * where the bytes themselves are needed.
 */
export async function playableSource(
  store: Store,
  path: string,
  kind: SourceKind = 'video',
): Promise<Blob> {
  const blob = await store.readBlob(path);
  if (blob === null) {
    throw new Error(`the file kept for this song is gone from ${path}`);
  }
  return blob.slice(0, blob.size, mediaTypeFor(path, kind));
}

/**
 * Bytes one song occupies: its stems, its job state and its kept source.
 *
 * A stem being written is locked by the worker, so while a job runs its size
 * reads as nothing. The figure settles once the job closes its files.
 */
export async function songBytes(store: Store, song: SongRecord): Promise<number> {
  let total = 0;
  for (const path of await store.list(song.stemsDirectory)) {
    total += (await store.sizeOf(path)) ?? 0;
  }
  return total;
}

export async function songSizes(
  store: Store,
  songs: readonly SongRecord[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const song of songs) {
    sizes.set(song.id, await songBytes(store, song));
  }
  return sizes;
}

export function totalBytes(sizes: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const bytes of sizes.values()) {
    total += bytes;
  }
  return total;
}

/** Removes a song's record and every byte it owns. */
export async function deleteSong(
  store: Store,
  songs: SongStore,
  song: SongRecord,
): Promise<void> {
  // Bytes first. A record pointing at nothing shows up as a broken song and
  // can be removed again; files with no record are invisible and stay forever.
  await store.remove(song.stemsDirectory);
  await songs.delete(song.id);
}
