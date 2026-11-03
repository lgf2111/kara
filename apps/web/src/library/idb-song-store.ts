import { byNewest, type SongRecord, type SongStore } from './songs.ts';

/**
 * The IndexedDB implementation of {@link SongStore}. Kept apart from the
 * interface and the in-memory store so tests, which run in Node, never pull
 * the database API into their program.
 *
 * One object store for now. Later milestones add their own under a higher
 * version rather than widening this one.
 *
 * Version 2 added the optional `lyrics` field to a song record. Nothing had to
 * be rewritten: a record saved under version 1 simply has no lyrics, which is
 * exactly what a song nobody has read lyrics for looks like either way. The
 * number is bumped so the shape change is on the record rather than in
 * somebody's memory.
 */

const DATABASE = 'kara';
const VERSION = 2;
const SONGS = 'songs';

let connection: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SONGS)) {
        request.result.createObjectStore(SONGS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('cannot open the kara database'));
  });
}

/** One connection for the tab, opened again if opening ever fails. */
function database(): Promise<IDBDatabase> {
  const existing = connection;
  if (existing !== null) {
    return existing;
  }
  const opening = openDatabase().catch((cause: unknown) => {
    connection = null;
    throw cause instanceof Error ? cause : new Error(String(cause));
  });
  connection = opening;
  return opening;
}

/**
 * Runs one request and waits for its transaction to commit, so a caller that
 * reads straight afterwards sees what it just wrote.
 */
async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  const transaction = db.transaction(SONGS, mode);
  const request = run(transaction.objectStore(SONGS));
  return new Promise<T>((resolve, reject) => {
    const fail = (): void => {
      reject(transaction.error ?? request.error ?? new Error('the kara database refused a write'));
    };
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = fail;
    transaction.onabort = fail;
  });
}

export function createIdbSongStore(): SongStore {
  return {
    async list() {
      const songs = await transact(
        'readonly',
        (store) => store.getAll() as IDBRequest<SongRecord[]>,
      );
      return songs.sort(byNewest);
    },
    async get(id) {
      const song = await transact(
        'readonly',
        (store) => store.get(id) as IDBRequest<SongRecord | undefined>,
      );
      return song ?? null;
    },
    async put(song) {
      await transact('readwrite', (store) => store.put(song));
    },
    async delete(id) {
      await transact('readwrite', (store) => store.delete(id));
    },
  };
}
