import { STEMS, type Stem } from '../audio/stems.ts';

/**
 * The OPFS half of the stem cache.
 *
 * One root, one directory per entry, and a marker file that is written last.
 * A directory without `complete` is never a cache hit, whatever else is in
 * it; `cleanup` removes those and any directory the metadata does not know
 * about. The directory name is a SHA-256 of the key, so the key's slashes,
 * titles and version strings never reach the filesystem.
 *
 * Files are opened lazily and kept open until `commit`. The store builds all
 * four stems before it begins this writer, so a failed separation never
 * leaves partial stem files at all; the marker still covers a crash during
 * the write itself.
 */

const CACHE_ROOT = 'kara-cache';
const CACHE_ENTRIES = 'entries';
const PARTIAL_MARKER = '.partial';
const COMPLETE_MARKER = 'complete';
const STEM_SUFFIX = '.audio';

export interface EntryWriter {
  write(stem: Stem, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Closes the files, writes the complete marker, and returns the byte size. */
  commit(): Promise<number>;
  /** Removes the entry directory and everything in it. */
  abort(): Promise<void>;
}

export interface CacheFiles {
  /** Starts a new entry, replacing any directory already under the key. */
  begin(key: string): Promise<EntryWriter>;
  /** One stem's whole file, or null when it is missing. */
  read(key: string, stem: Stem): Promise<Uint8Array | null>;
  /** True when the entry directory has a complete marker. */
  hasComplete(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /**
   * Removes directories that are incomplete or whose key is not in `keys`.
   * Returns how many directories were removed.
   */
  cleanup(keys: readonly string[]): Promise<number>;
}

const directoryNames = new Map<string, Promise<string>>();

function digestName(key: string): Promise<string> {
  const cached = directoryNames.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const name = (async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(key),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  })();
  directoryNames.set(key, name);
  return name;
}

async function entriesDirectory(
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  if (!create) {
    try {
      const cache = await root.getDirectoryHandle(CACHE_ROOT);
      return await cache.getDirectoryHandle(CACHE_ENTRIES);
    } catch {
      return null;
    }
  }
  const cache = await root.getDirectoryHandle(CACHE_ROOT, { create: true });
  return cache.getDirectoryHandle(CACHE_ENTRIES, { create: true });
}

async function writeMarker(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  await stream.close();
}

async function hasMarker(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export function createOpfsCacheFiles(): CacheFiles {
  return {
    async begin(key) {
      const entries = await entriesDirectory(true);
      if (entries === null) {
        throw new Error('stem cache: the cache directory is unavailable');
      }
      const name = await digestName(key);
      try {
        await entries.removeEntry(name, { recursive: true });
      } catch {
        // Nothing from an earlier attempt to replace.
      }
      const directory = await entries.getDirectoryHandle(name, { create: true });
      await writeMarker(directory, PARTIAL_MARKER);

      const streams = new Map<Stem, FileSystemWritableFileStream>();
      let settled = false;

      const abort = async (): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        for (const stream of streams.values()) {
          try {
            await stream.abort();
          } catch {
            // A stream that already failed cannot be aborted again.
          }
        }
        streams.clear();
        try {
          await entries.removeEntry(name, { recursive: true });
        } catch {
          // Already gone, or the context is going away.
        }
      };

      return {
        async write(stem, bytes) {
          let stream = streams.get(stem);
          if (stream === undefined) {
            const handle = await directory.getFileHandle(`${stem}${STEM_SUFFIX}`, {
              create: true,
            });
            stream = await handle.createWritable();
            streams.set(stem, stream);
          }
          await stream.write(bytes);
        },
        async commit() {
          if (settled) {
            return 0;
          }
          for (const stream of streams.values()) {
            await stream.close();
          }
          streams.clear();
          try {
            await directory.removeEntry(PARTIAL_MARKER);
          } catch {
            // A crash-recovered directory may have lost it already.
          }
          await writeMarker(directory, COMPLETE_MARKER);
          settled = true;
          let bytes = 0;
          for (const stem of STEMS) {
            try {
              const handle = await directory.getFileHandle(`${stem}${STEM_SUFFIX}`);
              bytes += (await handle.getFile()).size;
            } catch {
              // A missing file is a corrupt entry; its size is zero and the
              // read path will drop it.
            }
          }
          return bytes;
        },
        abort,
      };
    },

    async read(key, stem) {
      const entries = await entriesDirectory(false);
      if (entries === null) {
        return null;
      }
      try {
        const directory = await entries.getDirectoryHandle(await digestName(key));
        if (!(await hasMarker(directory, COMPLETE_MARKER))) {
          return null;
        }
        const handle = await directory.getFileHandle(`${stem}${STEM_SUFFIX}`);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch {
        return null;
      }
    },

    async hasComplete(key) {
      const entries = await entriesDirectory(false);
      if (entries === null) {
        return false;
      }
      try {
        const directory = await entries.getDirectoryHandle(await digestName(key));
        return await hasMarker(directory, COMPLETE_MARKER);
      } catch {
        return false;
      }
    },

    async remove(key) {
      const entries = await entriesDirectory(false);
      if (entries === null) {
        return;
      }
      try {
        await entries.removeEntry(await digestName(key), { recursive: true });
      } catch {
        // Already gone.
      }
    },

    async cleanup(keys) {
      const entries = await entriesDirectory(false);
      if (entries === null) {
        return 0;
      }
      const valid = new Set(
        await Promise.all(keys.map((key) => digestName(key))),
      );
      const names: string[] = [];
      for await (const name of entries.keys()) {
        names.push(name);
      }
      let removed = 0;
      for (const name of names) {
        if (valid.has(name)) {
          try {
            const directory = await entries.getDirectoryHandle(name);
            if (await hasMarker(directory, COMPLETE_MARKER)) {
              continue;
            }
          } catch {
            // Fall through and remove it.
          }
        }
        try {
          await entries.removeEntry(name, { recursive: true });
          removed += 1;
        } catch {
          // Something else is holding it; cleanup will try next start.
        }
      }
      return removed;
    },
  };
}
