import { directoryFor } from './opfs-paths.ts';

/**
 * The two mechanisms for replacing a file's contents. Which one is used is
 * `opfs-support.ts`'s decision; this file only knows how.
 */

/** Read back in pieces this big, so a kept video is never one allocation. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Through a sync access handle, which is the only writer Safari has and is
 * available in dedicated workers alone.
 *
 * The blob is read a slice at a time rather than whole: a four-minute video
 * is tens of megabytes, and the point of keeping the person's own file is
 * lost if keeping it needs the file twice over in memory.
 */
export async function writeWithSyncAccess(path: string, blob: Blob): Promise<void> {
  const [directory, name] = await directoryFor(path, true);
  const handle = await directory.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    // Whatever was there is gone: these writers all replace the file.
    access.truncate(0);
    let at = 0;
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, blob.size);
      const piece = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      access.write(piece, { at });
      at += piece.byteLength;
    }
    access.flush();
  } finally {
    // The handle holds an exclusive lock on the file, so it has to go even
    // when the write failed, or nothing can read the song again.
    access.close();
  }
}

/**
 * Through a writable stream, which stages the write and commits it on close.
 * Fine for a whole-file replacement, which is all of these are.
 */
export async function writeWithStream(path: string, blob: Blob): Promise<void> {
  const [directory, name] = await directoryFor(path, true);
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable({ keepExistingData: false });
  try {
    // Handed over whole: the browser copies it on its own side, so the bytes
    // never pass through this heap.
    await stream.write(blob);
  } catch (cause) {
    await stream.abort().catch(() => undefined);
    throw cause;
  }
  await stream.close();
}
