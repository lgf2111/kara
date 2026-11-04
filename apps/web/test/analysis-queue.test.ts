import { describe, expect, it } from 'vitest';

import {
  analysisKeyFor,
  drop,
  emptyQueue,
  enqueue,
  finish,
  isQueued,
  placeInQueue,
  queueLength,
  startNext,
  updateQueued,
  type AnalysisItem,
  type JobQueue,
} from '../src/separation/queue.ts';

function item(key: string, songId: string | null = null): AnalysisItem {
  return { key, title: key, songId };
}

/** The queue after several files were handed over at once. */
function queued(...keys: string[]): JobQueue<AnalysisItem> {
  return keys.reduce((queue, key) => enqueue(queue, item(key)), emptyQueue<AnalysisItem>());
}

describe('an empty queue', () => {
  it('has nothing running and nothing to run', () => {
    const queue = emptyQueue<AnalysisItem>();
    expect(queue.running).toBeNull();
    expect(queue.waiting).toEqual([]);
    expect(queueLength(queue)).toBe(0);
    expect(startNext(queue)).toBe(queue);
  });
});

describe('enqueue', () => {
  it('keeps the order the files arrived in', () => {
    expect(queued('a', 'b', 'c').waiting.map((job) => job.key)).toEqual(['a', 'b', 'c']);
  });

  it('does not queue the same file twice', () => {
    const queue = queued('a', 'b');
    expect(enqueue(queue, item('a'))).toBe(queue);
    expect(queue.waiting).toHaveLength(2);
  });

  it('does not queue the file that is already running', () => {
    const running = startNext(queued('a', 'b'));
    expect(enqueue(running, item('a'))).toBe(running);
    expect(isQueued(running, 'a')).toBe(true);
  });
});

describe('startNext', () => {
  it('takes the one at the front', () => {
    const started = startNext(queued('a', 'b', 'c'));
    expect(started.running?.key).toBe('a');
    expect(started.waiting.map((job) => job.key)).toEqual(['b', 'c']);
  });

  it('runs one at a time: nothing moves while a job holds the machine', () => {
    const running = startNext(queued('a', 'b'));
    expect(startNext(running)).toBe(running);
    expect(running.running?.key).toBe('a');
  });

  it('works through the whole queue, in order, as each one ends', () => {
    let queue = queued('a', 'b', 'c');
    const order: string[] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      queue = startNext(queue);
      const running = queue.running;
      expect(running).not.toBeNull();
      if (running !== null) {
        order.push(running.key);
        queue = finish(queue, running.key);
      }
    }
    expect(order).toEqual(['a', 'b', 'c']);
    expect(queueLength(queue)).toBe(0);
  });
});

describe('finish', () => {
  it('frees the machine for the next one', () => {
    const queue = finish(startNext(queued('a', 'b')), 'a');
    expect(queue.running).toBeNull();
    expect(startNext(queue).running?.key).toBe('b');
  });

  it('leaves a job that is not the one that ended alone', () => {
    const queue = finish(startNext(queued('a', 'b')), 'b');
    expect(queue.running?.key).toBe('a');
    expect(queue.waiting).toEqual([]);
  });
});

describe('drop', () => {
  it('takes a waiting job out and closes the gap', () => {
    expect(drop(queued('a', 'b', 'c'), 'b').waiting.map((job) => job.key)).toEqual(['a', 'c']);
  });

  it('leaves the running job to the worker', () => {
    const running = drop(startNext(queued('a', 'b')), 'a');
    expect(running.running?.key).toBe('a');
  });
});

describe('updateQueued', () => {
  it('records what the decode worked out without moving the job', () => {
    const queue = updateQueued(queued('a', 'b'), 'b', (job) => ({ ...job, songId: 'song-b' }));
    expect(queue.waiting.map((job) => job.songId)).toEqual([null, 'song-b']);
  });

  it('reaches the running job too', () => {
    const queue = updateQueued(startNext(queued('a')), 'a', (job) => ({
      ...job,
      songId: 'song-a',
    }));
    expect(queue.running?.songId).toBe('song-a');
  });
});

describe('placeInQueue', () => {
  it('counts from the front, one for next up', () => {
    const queue = queued('a', 'b', 'c');
    expect(placeInQueue(queue, (job) => job.key === 'a')).toBe(1);
    expect(placeInQueue(queue, (job) => job.key === 'c')).toBe(3);
  });

  it('is nothing for a job that is running or not here at all', () => {
    const running = startNext(queued('a', 'b'));
    expect(placeInQueue(running, (job) => job.key === 'a')).toBeNull();
    expect(placeInQueue(running, (job) => job.key === 'z')).toBeNull();
  });

  it('finds a job by whatever the player knows it as', () => {
    const queue = updateQueued(queued('a', 'b'), 'b', (job) => ({ ...job, songId: 'song-b' }));
    expect(placeInQueue(queue, (job) => job.songId === 'song-b')).toBe(2);
  });
});

describe('analysisKeyFor', () => {
  it('is the same for the same file, so dropping it twice is one job', () => {
    expect(analysisKeyFor('take.mp4', 2048, 170)).toBe(analysisKeyFor('take.mp4', 2048, 170));
  });

  it('tells two different files apart', () => {
    const key = analysisKeyFor('take.mp4', 2048, 170);
    expect(analysisKeyFor('other.mp4', 2048, 170)).not.toBe(key);
    expect(analysisKeyFor('take.mp4', 4096, 170)).not.toBe(key);
    expect(analysisKeyFor('take.mp4', 2048, 171)).not.toBe(key);
  });
});
