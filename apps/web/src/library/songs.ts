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

/** One line of lyrics, timed from the start of the song. */
export interface LyricLine {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface SongLyrics {
  readonly lines: readonly LyricLine[];
  /** How the lines were got. One way so far: read off the video's own picture. */
  readonly source: 'video-ocr';
  readonly readAt: string;
}

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
  /**
   * Lines read off the video, absent until someone asks for them. They stay on
   * this device: a recipe carries timings, and lyric text only when the person
   * exporting ticks the box.
   */
  readonly lyrics?: SongLyrics;
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

/**
 * Whether there is anything to play.
 *
 * A kept video plays whatever its stems are doing, picture, own sound and
 * all. A song that came in as audio kept no file, so its stems are the only
 * copy of it on this device and there is nothing to play until they are
 * finished.
 */
export function canPlay(song: SongRecord): boolean {
  return song.sourcePath !== null || song.status === 'ready';
}

/**
 * Whether there is anything to read lyrics from. Only the video's own picture
 * carries words, and only while the worker is not holding its files open.
 */
export function canReadLyrics(song: SongRecord): boolean {
  return song.sourceKind === 'video' && song.sourcePath !== null && song.status !== 'separating';
}

export function withLyrics(song: SongRecord, lyrics: SongLyrics): SongRecord {
  return { ...song, lyrics };
}

/**
 * The record without its lines, which is how lyrics are taken away again. The
 * field goes rather than turning empty, so a song nobody has read lyrics for
 * and a song whose lyrics were removed are the same record.
 */
export function withoutLyrics(song: SongRecord): SongRecord {
  const { lyrics, ...rest } = song;
  return lyrics === undefined ? song : rest;
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
