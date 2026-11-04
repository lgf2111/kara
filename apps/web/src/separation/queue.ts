/**
 * The order several songs are analysed in.
 *
 * One separation already takes every core this machine has and a few hundred
 * megabytes of float32, so a second alongside it would not run faster, it
 * would run out of memory. Dropping a handful of files in therefore queues
 * them, and this file is that order: arithmetic over a list, kept free of
 * React and of the worker so it can be tested on its own.
 */

/** Anything the queue can hold: known by its key, and nameable. */
export interface Queued {
  /**
   * Stable for one picked file, so the same file handed over twice is one job
   * and a cancelled one can be put back where it was.
   */
  readonly key: string;
  readonly title: string;
}

/** A file waiting to be analysed, or being analysed now. */
export interface AnalysisItem extends Queued {
  /** The song record's id, which is only known once the file is decoded. */
  readonly songId: string | null;
}

/** The job holding the machine, with whatever the worker last reported. */
export interface AnalysisJob extends AnalysisItem {
  readonly stage: string;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly etaMs: number | null;
  /** Non-zero when this run carried on from one that was stopped. */
  readonly resumedFrom: number;
}

export interface JobQueue<T extends Queued> {
  /** The one job holding the machine, or null while nothing is. */
  readonly running: T | null;
  /** Waiting, in the order they arrived. */
  readonly waiting: readonly T[];
}

export function emptyQueue<T extends Queued>(): JobQueue<T> {
  return { running: null, waiting: [] };
}

/**
 * A key for one picked file. Deliberately not a hash of its bytes: that would
 * mean reading the whole file before knowing whether it is already queued,
 * and the song's own id already costs a decode to work out.
 */
export function analysisKeyFor(name: string, bytes: number, modifiedMs: number): string {
  return `${name}/${String(bytes)}/${String(modifiedMs)}`;
}

export function isQueued<T extends Queued>(queue: JobQueue<T>, key: string): boolean {
  return queue.running?.key === key || queue.waiting.some((item) => item.key === key);
}

/** Appended at the back, unless this file is in the queue already. */
export function enqueue<T extends Queued>(queue: JobQueue<T>, item: T): JobQueue<T> {
  if (isQueued(queue, item.key)) {
    return queue;
  }
  return { running: queue.running, waiting: [...queue.waiting, item] };
}

/** The next job, if the machine is free. Nothing moves while one is running. */
export function startNext<T extends Queued>(queue: JobQueue<T>): JobQueue<T> {
  if (queue.running !== null) {
    return queue;
  }
  const [next, ...rest] = queue.waiting;
  return next === undefined ? queue : { running: next, waiting: rest };
}

/** However the job ended: finished, cancelled or failed. */
export function finish<T extends Queued>(queue: JobQueue<T>, key: string): JobQueue<T> {
  return {
    running: queue.running?.key === key ? null : queue.running,
    waiting: queue.waiting.filter((item) => item.key !== key),
  };
}

/**
 * Takes a waiting job out of the queue. The running one is left alone:
 * stopping that is the worker's business, and it has bytes to finish writing.
 */
export function drop<T extends Queued>(queue: JobQueue<T>, key: string): JobQueue<T> {
  return { running: queue.running, waiting: queue.waiting.filter((item) => item.key !== key) };
}

/** The same job with something new known about it, in the place it already had. */
export function updateQueued<T extends Queued>(
  queue: JobQueue<T>,
  key: string,
  change: (item: T) => T,
): JobQueue<T> {
  const running = queue.running;
  return {
    running: running !== null && running.key === key ? change(running) : running,
    waiting: queue.waiting.map((item) => (item.key === key ? change(item) : item)),
  };
}

/**
 * Where the job this matches is waiting: 1 for next up, or null when it is
 * not waiting at all. Matched by a predicate rather than a key, because the
 * player knows the song on its stage by record id as often as by file.
 */
export function placeInQueue<T extends Queued>(
  queue: JobQueue<T>,
  matches: (item: T) => boolean,
): number | null {
  const at = queue.waiting.findIndex((item) => matches(item));
  return at < 0 ? null : at + 1;
}

/** Jobs still to get through, the running one included. */
export function queueLength<T extends Queued>(queue: JobQueue<T>): number {
  return (queue.running === null ? 0 : 1) + queue.waiting.length;
}
