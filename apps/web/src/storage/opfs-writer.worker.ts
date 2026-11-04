/// <reference lib="webworker" />
import { writeWithSyncAccess } from './opfs-write.ts';
import type { WriteReply, WriteRequest } from './writer-protocol.ts';

/**
 * Writes files for the page.
 *
 * Safari has no `createWritable` on origin private files, and its one writer,
 * `createSyncAccessHandle`, exists only in a dedicated worker. So the page
 * keeps this worker alive and posts writes to it. Nothing else happens here:
 * no decoding, no separation, and one file at a time, so a long video being
 * copied in cannot be interleaved with the job state being saved beneath it.
 */

function reply(message: WriteReply): void {
  self.postMessage(message);
}

/** Serialised: two sync handles on one file would deadlock on its lock. */
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<WriteRequest>) => {
  const request = event.data;
  if (request.kind !== 'write') {
    return;
  }
  queue = queue.then(async () => {
    try {
      await writeWithSyncAccess(request.path, request.blob);
      reply({ kind: 'written', id: request.id });
    } catch (cause) {
      reply({
        kind: 'failed',
        id: request.id,
        error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      });
    }
  });
});
