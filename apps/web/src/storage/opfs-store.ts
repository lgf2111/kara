import { directoryFor } from './opfs-paths.ts';
import { NO_WRITER, abilitiesHere, writeRouteFor } from './opfs-support.ts';
import { writeWithStream, writeWithSyncAccess } from './opfs-write.ts';
import { writeInWorker } from './opfs-writer.ts';
import type { AppendableFile, Store } from './store.ts';

/**
 * The OPFS implementation of {@link Store}. Kept apart from the interface and
 * the in-memory store so that tests, which run in Node, never pull the
 * filesystem API types into their program.
 *
 * Every write goes through {@link writeWhole} rather than straight to a
 * stream. Safari has no `createWritable` on these files, so writing from the
 * page there means handing the bytes to a worker; writing it inline worked in
 * Chrome and failed silently in Safari, which is the bug this routing exists
 * to close.
 */

/** One file replaced, by whichever writer this context has. */
async function writeWhole(path: string, blob: Blob): Promise<void> {
  switch (writeRouteFor(abilitiesHere())) {
    case 'sync-access-here':
      return writeWithSyncAccess(path, blob);
    case 'writable-stream':
      return writeWithStream(path, blob);
    case 'sync-access-worker':
      return writeInWorker(path, blob);
    case 'none':
      throw new Error(NO_WRITER);
  }
}

/**
 * Appends through a sync access handle, which is worker-only and writes
 * through rather than buffering.
 *
 * `createWritable` would be wrong here even where it exists: it stages
 * everything in a swap file and only commits when the stream closes, so
 * killing the tab mid-job loses every byte written since the stream opened. A
 * resumable job needs each segment to be durable the moment it is written,
 * which is what flush() gives. The handle holds an exclusive lock, so the
 * page cannot read a stem until the job closes it.
 */
async function openAppend(path: string): Promise<AppendableFile> {
  if (!abilitiesHere().syncAccess) {
    // Only the separation worker appends, and it is a dedicated worker in
    // every browser this runs in. Reaching here means somebody moved that
    // call to the page, where no browser allows it.
    throw new Error(`${path} can only be appended to from a dedicated worker`);
  }
  const [directory, name] = await directoryFor(path, true);
  const handle = await directory.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  let bytes = access.getSize();
  let open = true;

  return {
    path,
    size() {
      return bytes;
    },
    append(data) {
      if (!open) {
        throw new Error(`${path} is closed`);
      }
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      access.write(view, { at: bytes });
      bytes += view.byteLength;
      access.flush();
      return Promise.resolve();
    },
    truncate(limit) {
      if (!open) {
        throw new Error(`${path} is closed`);
      }
      access.truncate(limit);
      bytes = Math.min(bytes, limit);
      access.flush();
      return Promise.resolve();
    },
    close() {
      if (open) {
        access.flush();
        access.close();
        open = false;
      }
      return Promise.resolve();
    },
  };
}

export function createOpfsStore(): Store {
  return {
    openAppend,
    async readJson(path) {
      try {
        const [directory, name] = await directoryFor(path, false);
        const file = await (await directory.getFileHandle(name)).getFile();
        return JSON.parse(await file.text()) as unknown;
      } catch {
        return null;
      }
    },
    writeJson(path, value) {
      return writeWhole(path, new Blob([JSON.stringify(value)]));
    },
    async readFloat32(path) {
      try {
        const [directory, name] = await directoryFor(path, false);
        const file = await (await directory.getFileHandle(name)).getFile();
        return new Float32Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
    writeFloat32(path, data) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return writeWhole(path, new Blob([view]));
    },
    writeBlob(path, blob) {
      return writeWhole(path, blob);
    },
    async readBlob(path) {
      try {
        const [directory, name] = await directoryFor(path, false);
        // The File is a handle, not a copy: nothing is read until whoever
        // holds it asks for a range, which is what a media element does.
        return await (await directory.getFileHandle(name)).getFile();
      } catch {
        return null;
      }
    },
    async readBytes(path, offset, length) {
      try {
        const [directory, name] = await directoryFor(path, false);
        const file = await (await directory.getFileHandle(name)).getFile();
        // Slicing a File reads only the range asked for, so a long stem never
        // has to be materialised whole.
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      } catch {
        return null;
      }
    },
    async sizeOf(path) {
      try {
        const [directory, name] = await directoryFor(path, false);
        return (await (await directory.getFileHandle(name)).getFile()).size;
      } catch {
        return null;
      }
    },
    async remove(path) {
      const parts = path.split('/').filter((part) => part.length > 0);
      const name = parts.pop();
      if (name === undefined) {
        return;
      }
      let directory = await navigator.storage.getDirectory();
      try {
        for (const part of parts) {
          directory = await directory.getDirectoryHandle(part);
        }
        await directory.removeEntry(name, { recursive: true });
      } catch {
        // already gone
      }
    },
    async list(prefix) {
      const parts = prefix.split('/').filter((part) => part.length > 0);
      let directory = await navigator.storage.getDirectory();
      try {
        for (const part of parts) {
          directory = await directory.getDirectoryHandle(part);
        }
      } catch {
        return [];
      }
      const names: string[] = [];
      for await (const key of directory.keys()) {
        names.push(`${parts.join('/')}/${key}`);
      }
      return names.sort();
    },
    async usedBytes() {
      const estimate = await navigator.storage.estimate();
      return estimate.usage ?? 0;
    },
  };
}
