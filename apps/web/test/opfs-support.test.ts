import { describe, expect, it } from 'vitest';

import { writeRouteFor, type WriteAbilities } from '../src/storage/opfs-support.ts';

/** The three questions, so each case below only states what it changes. */
function abilities(partial: Partial<WriteAbilities>): WriteAbilities {
  return { inWorker: false, writableStream: false, syncAccess: false, ...partial };
}

describe('writeRouteFor', () => {
  it('writes through a sync handle inside a worker, even where a stream exists', () => {
    // Chrome in a worker. The sync handle is preferred because it writes
    // through, which is what makes a killed separation resumable.
    expect(
      writeRouteFor(abilities({ inWorker: true, writableStream: true, syncAccess: true })),
    ).toBe('sync-access-here');
    expect(writeRouteFor(abilities({ inWorker: true, syncAccess: true }))).toBe(
      'sync-access-here',
    );
  });

  it('falls back to a stream in a worker that has no sync handle', () => {
    expect(writeRouteFor(abilities({ inWorker: true, writableStream: true }))).toBe(
      'writable-stream',
    );
  });

  it('says a worker with neither cannot write at all', () => {
    expect(writeRouteFor(abilities({ inWorker: true }))).toBe('none');
  });

  it('writes from the page where the page has a stream', () => {
    // Chrome on the page: createWritable is there, so nothing is posted.
    expect(writeRouteFor(abilities({ writableStream: true }))).toBe('writable-stream');
  });

  it('hands the page’s writes to the worker when the page has no stream', () => {
    // Safari. It has no createWritable at all, and createSyncAccessHandle
    // exists only in a worker, so this is the whole reason the worker exists.
    expect(writeRouteFor(abilities({}))).toBe('sync-access-worker');
    // Even if a sync handle somehow appeared on the page, it could not be
    // opened there, so the answer is the same.
    expect(writeRouteFor(abilities({ syncAccess: true }))).toBe('sync-access-worker');
  });
});
