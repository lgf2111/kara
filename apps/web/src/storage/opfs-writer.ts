import { TroubleError } from '../notices/notices.ts';
import type { WriteReply, WriteRequest } from './writer-protocol.ts';

/**
 * The page's side of the writer worker.
 *
 * One worker for the tab, started the first time something needs writing and
 * kept afterwards: starting one per write would cost a module load per saved
 * file, and the library saves job state after every segment.
 */

interface Waiting {
  resolve(): void;
  reject(cause: unknown): void;
}

let worker: Worker | null = null;
const waiting = new Map<number, Waiting>();
let nextId = 0;

/** Everything in flight fails together: the worker is gone for all of them. */
function breakOff(reason: string): void {
  worker = null;
  const failed = [...waiting.values()];
  waiting.clear();
  for (const waiter of failed) {
    waiter.reject(new TroubleError('storage', reason));
  }
}

function open(): Worker {
  const existing = worker;
  if (existing !== null) {
    return existing;
  }
  const started = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), {
    type: 'module',
  });
  started.addEventListener('message', (event: MessageEvent<WriteReply>) => {
    const message = event.data;
    const waiter = waiting.get(message.id);
    if (waiter === undefined) {
      return;
    }
    waiting.delete(message.id);
    if (message.kind === 'written') {
      waiter.resolve();
    } else {
      // Whatever the worker could not do, it could not do to the filesystem,
      // so the notice says that rather than blaming the song.
      waiter.reject(new TroubleError('storage', message.error));
    }
  });
  started.addEventListener('error', (event) => {
    breakOff(
      event.message === '' ? 'the file writer stopped without saying why' : event.message,
    );
  });
  worker = started;
  return started;
}

/** Replaces a file's contents, in the worker, and settles when it is on disk. */
export function writeInWorker(path: string, blob: Blob): Promise<void> {
  const started = open();
  nextId += 1;
  const id = nextId;
  return new Promise<void>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const request: WriteRequest = { kind: 'write', id, path, blob };
    started.postMessage(request);
  });
}
