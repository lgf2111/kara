import type { CachedEntry } from './entry.ts';
import { CACHE_METADATA_VERSION } from './entry.ts';
import type { CacheMetadata } from './metadata-contract.ts';

/**
 * The cache's metadata, in an OPFS file beside the stems.
 *
 * `chrome.storage.local` is not available in an offscreen document, and the
 * engine lives there. OPFS is: the offscreen document, the popup and any
 * other extension page share one origin and one storage bucket, so a record
 * written by a session is visible to the popup that clears it and survives a
 * navigation. The file is `kara-cache/index.json`; the entry directories are
 * its neighbours under `kara-cache/entries/`.
 *
 * **A commit is a replace, not an edit.** The new document is written to
 * `index.json.tmp` in full, then moved over `index.json` where the platform
 * supports `FileSystemFileHandle.move`. A crash before the move leaves the
 * old index intact and the new one as a complete temp file, which the next
 * read adopts. Where `move` is missing the target is written through
 * `createWritable`, which the OPFS specification already swaps in atomically
 * on close.
 *
 * **One context is serialised here; two contexts are not.** The store already
 * puts every mutation on one promise chain, and this adapter has its own for
 * direct writers such as the popup's clear. Two extension pages can still
 * interleave a read-modify-write, which is why a `navigator.locks` lock
 * around the whole transaction would be needed if concurrent writers became a
 * real case. Today a session and the popup are the only writers, and the
 * popup refuses to clear while a session is running.
 */

export const CACHE_INDEX_DIRECTORY = 'kara-cache';
export const CACHE_INDEX_FILE = 'index.json';
export const CACHE_INDEX_TEMP = 'index.json.tmp';

/**
 * The four file operations the index needs, kept apart from OPFS so the
 * commit and recovery rules can be tested without a browser.
 */
export interface IndexDirectory {
  /** The file's text, or null when it is missing. */
  readText(name: string): Promise<string | null>;
  /** Replaces the file at `name`. */
  writeText(name: string, text: string): Promise<void>;
  /** Moves `from` over `to`. False when the platform has no `move`. */
  move(from: string, to: string): Promise<boolean>;
  remove(name: string): Promise<void>;
}

/** The index as the metadata adapter sees it: one text document. */
export interface CacheIndexFile {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

interface IndexNames {
  readonly file: string;
  readonly temp: string;
}

const DEFAULT_NAMES: IndexNames = { file: CACHE_INDEX_FILE, temp: CACHE_INDEX_TEMP };

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit and recovery rules over any directory.
 *
 * Read prefers a valid main file. A missing or corrupt main with a valid temp
 * is an interrupted commit, and the temp is adopted rather than thrown away.
 * Write never edits the main file in place before the complete temp exists.
 */
export function createIndexFileStore(
  directory: IndexDirectory,
  names: IndexNames = DEFAULT_NAMES,
): CacheIndexFile {
  return {
    async read() {
      const main = await directory.readText(names.file);
      if (main !== null && parses(main)) {
        return main;
      }
      const temp = await directory.readText(names.temp);
      if (temp !== null && parses(temp)) {
        // Finish the interrupted commit. A move that fails for any reason
        // still leaves the recovered document readable in place.
        const moved = await directory.move(names.temp, names.file).catch(() => false);
        if (!moved) {
          await directory.writeText(names.file, temp).catch(() => undefined);
          await directory.remove(names.temp).catch(() => undefined);
        }
        return temp;
      }
      // Neither parses: hand back what was there so the caller can treat a
      // damaged index as empty and let the filesystem cleanup take over.
      return main ?? temp;
    },

    async write(text) {
      await directory.writeText(names.temp, text);
      let moved = await directory.move(names.temp, names.file).catch(() => false);
      if (!moved) {
        // Some builds refuse to move over an existing file. Removing the old
        // one is safe because the complete temp is the recovery source until
        // the new main exists.
        await directory.remove(names.file).catch(() => undefined);
        moved = await directory.move(names.temp, names.file).catch(() => false);
      }
      if (!moved) {
        // No `move` at all: `createWritable` swaps the target on close, so the
        // document is still never observed half-written.
        await directory.writeText(names.file, text);
        await directory.remove(names.temp).catch(() => undefined);
      }
    },
  };
}

interface MovableFileHandle extends FileSystemFileHandle {
  move?: (
    destination: FileSystemDirectoryHandle,
    newName?: string,
  ) => Promise<void>;
}

/** OPFS itself: one directory under the origin's storage root. */
export function createOpfsIndexDirectory(
  directoryName: string = CACHE_INDEX_DIRECTORY,
): IndexDirectory {
  const cacheDirectory = async (
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> => {
    const root = await navigator.storage.getDirectory();
    if (!create) {
      try {
        return await root.getDirectoryHandle(directoryName);
      } catch {
        return null;
      }
    }
    return root.getDirectoryHandle(directoryName, { create: true });
  };

  return {
    async readText(name) {
      const directory = await cacheDirectory(false);
      if (directory === null) {
        return null;
      }
      try {
        const handle = await directory.getFileHandle(name);
        return await (await handle.getFile()).text();
      } catch {
        return null;
      }
    },

    async writeText(name, text) {
      const directory = await cacheDirectory(true);
      if (directory === null) {
        throw new Error('stem cache: the index directory is unavailable');
      }
      const handle = await directory.getFileHandle(name, { create: true });
      const stream = await handle.createWritable();
      await stream.write(text);
      await stream.close();
    },

    async move(from, to) {
      const directory = await cacheDirectory(false);
      if (directory === null) {
        return false;
      }
      try {
        const handle = await directory.getFileHandle(from);
        const movable = handle as MovableFileHandle;
        if (typeof movable.move !== 'function') {
          return false;
        }
        await movable.move(directory, to);
        return true;
      } catch {
        return false;
      }
    },

    async remove(name) {
      const directory = await cacheDirectory(false);
      if (directory === null) {
        return;
      }
      try {
        await directory.removeEntry(name);
      } catch {
        // Already gone, or the context is going away.
      }
    },
  };
}

function metadataDocument(entries: readonly CachedEntry[]): {
  readonly version: number;
  readonly entries: readonly CachedEntry[];
} {
  return { version: CACHE_METADATA_VERSION, entries };
}

export interface OpfsCacheMetadataOptions {
  /** A directory other than the extension's own, for a test or a debug page. */
  readonly directory?: IndexDirectory;
  /** A fully built index file, which takes precedence over `directory`. */
  readonly file?: CacheIndexFile;
}

/**
 * The metadata contract over the OPFS index.
 *
 * Writes are serialised inside this context. Reads are not queued: a replace
 * is atomic, so a reader sees either the old document or the new one.
 */
export function createOpfsCacheMetadata(
  options: OpfsCacheMetadataOptions = {},
): CacheMetadata {
  const file =
    options.file ??
    createIndexFileStore(options.directory ?? createOpfsIndexDirectory());
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async read() {
      const text = await file.read();
      if (text === null) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },

    write(entries) {
      return serial(async () => {
        await file.write(JSON.stringify(metadataDocument(entries)));
      });
    },
  };
}
