import type { Store } from '../storage/store.ts';
import type { SongRecord, SongStore } from './songs.ts';

/**
 * What the library occupies, and how a song is taken away again. Browser-free
 * on purpose: everything here goes through {@link Store}, so it can be tested
 * against the in-memory store.
 */

/** Where a video's own bytes are kept, inside the directory the job owns. */
export function sourcePathFor(directory: string, fileName: string): string {
  const match = /\.[a-z0-9]{1,5}$/iu.exec(fileName);
  return `${directory}/source${match === null ? '' : match[0].toLowerCase()}`;
}

/**
 * Bytes one song occupies: its stems, its job state and any kept source.
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
