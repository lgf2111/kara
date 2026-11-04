/**
 * Walking a slash-separated path down the origin private filesystem, which
 * only knows directories one name at a time.
 *
 * Its own file because both the store and the writer worker need it, and the
 * worker must not pull the whole store in to get at it.
 */
export async function directoryFor(
  path: string,
  create: boolean,
): Promise<[FileSystemDirectoryHandle, string]> {
  const parts = path.split('/').filter((part) => part.length > 0);
  const name = parts.pop();
  if (name === undefined) {
    throw new Error(`not a file path: ${path}`);
  }
  let directory = await navigator.storage.getDirectory();
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return [directory, name];
}
