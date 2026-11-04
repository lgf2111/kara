/**
 * Which of the two ways of writing a file this context actually has.
 *
 * The filesystem has two writers and no browser has both everywhere.
 * `createWritable` is a stream, and Safari does not offer it on origin
 * private files at all. `createSyncAccessHandle` is the one Safari does
 * offer, and it exists only inside a dedicated worker: calling it on the page
 * throws. So a write from the page in Safari has to be handed to a worker,
 * and a write already inside a worker can do it where it stands.
 *
 * Pure: the decision is the part worth testing, and it is the part that was
 * wrong, so it is not left inline in the store.
 */

export interface WriteAbilities {
  /** Whether this code is running in a worker rather than on the page. */
  readonly inWorker: boolean;
  /** `createWritable` is on the handle. Absent in Safari. */
  readonly writableStream: boolean;
  /** `createSyncAccessHandle` is on the handle. Worker scopes only. */
  readonly syncAccess: boolean;
}

export type WriteRoute =
  /** A sync access handle, opened here. Durable per flush, worker only. */
  | 'sync-access-here'
  /** A writable stream, which commits when it closes. */
  | 'writable-stream'
  /** Posted to the writer worker, which opens a sync access handle there. */
  | 'sync-access-worker'
  /** Nothing in this context can write. The caller has to say so out loud. */
  | 'none';

export function writeRouteFor(abilities: WriteAbilities): WriteRoute {
  if (abilities.inWorker) {
    // Preferred even where a stream exists: a sync handle writes through, so
    // a tab killed mid-job keeps every byte already flushed, which is what
    // makes a separation resumable.
    if (abilities.syncAccess) {
      return 'sync-access-here';
    }
    return abilities.writableStream ? 'writable-stream' : 'none';
  }
  if (abilities.writableStream) {
    return 'writable-stream';
  }
  // Safari on the page. Whether the worker can do it is not knowable from
  // here, so the work goes there and the worker reports its own failure.
  return 'sync-access-worker';
}

/** Why nothing could be written, for a message somebody has to be shown. */
export const NO_WRITER =
  'this browser offers no way to write to its own private filesystem, so songs cannot be kept on this device';

export function abilitiesHere(): WriteAbilities {
  const handle =
    typeof FileSystemFileHandle === 'undefined' ? null : FileSystemFileHandle.prototype;
  return {
    // A worker has no `window`. Checked this way round so the page, where the
    // property is always there, is the one that needs no feature test.
    inWorker: typeof window === 'undefined',
    writableStream: handle !== null && 'createWritable' in handle,
    syncAccess: handle !== null && 'createSyncAccessHandle' in handle,
  };
}
