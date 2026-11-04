import type { WriteAbilities } from './opfs-support.ts';

/**
 * What this browser, in this scope, can actually do to a file.
 *
 * Kept apart from {@link writeRouteFor}'s file so the decision stays free of
 * the filesystem types: the tests run in Node, where `FileSystemFileHandle`
 * does not exist, and they are about the decision rather than the probe.
 */
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
