/**
 * The library's metadata: one small record per song. Bytes live in OPFS and
 * are never copied in here, so the whole library can be read at once.
 *
 * This file holds the record, the store interface and an in-memory store, and
 * stays free of browser APIs so tests can import it. The IndexedDB store lives
 * in `idb-song-store.ts`.
 */

export type SongStatus = 'separating' | 'ready' | 'cancelled' | 'failed';

export type SourceKind = 'audio' | 'video';

export interface SongRecord {
  /** The separation job id, so reopening the same file finds its stems. */
  readonly id: string;
  readonly title: string;
  readonly durationMs: number;
  /** Size of the file the person picked. */
  readonly sourceBytes: number;
  readonly sourceKind: SourceKind;
  readonly status: SongStatus;
  /**
   * OPFS directory holding this song's stems, its job state and, for a video,
   * its own bytes. Removing it removes everything the song owns.
   */
  readonly stemsDirectory: string;
  /** Where a video's own bytes are kept for the room background, else null. */
  readonly sourcePath: string | null;
  readonly createdAt: string;
}

export interface SongStore {
  /** Every song, newest first. */
  list(): Promise<SongRecord[]>;
  get(id: string): Promise<SongRecord | null>;
  put(song: SongRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Newest first, falling back to the id so the order is never arbitrary. */
export function byNewest(a: SongRecord, b: SongRecord): number {
  const byTime = b.createdAt.localeCompare(a.createdAt);
  return byTime === 0 ? a.id.localeCompare(b.id) : byTime;
}

/**
 * Containers whose video track we keep as a background. The browser decides
 * what it can decode; this only decides whether the picture is worth keeping.
 */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi']);

export function sourceKindFor(fileName: string, mimeType = ''): SourceKind {
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension) ? 'video' : 'audio';
}

/**
 * A title to show until someone edits it. The file name is all we have: no
 * tags are read, and nothing is looked up over the network.
 */
export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[a-z0-9]{1,5}$/iu, '');
  const cleaned = (withoutExtension === '' ? fileName : withoutExtension)
    .replaceAll('_', ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned === '' ? fileName : cleaned;
}

export function createMemorySongStore(initial: readonly SongRecord[] = []): SongStore {
  const songs = new Map<string, SongRecord>(initial.map((song) => [song.id, song]));

  return {
    list() {
      return Promise.resolve([...songs.values()].sort(byNewest));
    },
    get(id) {
      return Promise.resolve(songs.get(id) ?? null);
    },
    put(song) {
      songs.set(song.id, song);
      return Promise.resolve();
    },
    delete(id) {
      songs.delete(id);
      return Promise.resolve();
    },
  };
}
