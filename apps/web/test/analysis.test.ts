import { describe, expect, it } from 'vitest';

import {
  analysisShare,
  describeAnalysis,
  stageAnalysis,
  vocalToggle,
  type AnalysisView,
} from '../src/player/analysis.ts';
import {
  emptyQueue,
  enqueue,
  startNext,
  updateQueued,
  type AnalysisItem,
  type AnalysisJob,
  type JobQueue,
} from '../src/separation/queue.ts';

function item(key: string, songId: string | null = null): AnalysisItem {
  return { key, title: key, songId };
}

function queued(...keys: string[]): JobQueue<AnalysisItem> {
  return keys.reduce((queue, key) => enqueue(queue, item(key)), emptyQueue<AnalysisItem>());
}

/** The worker partway through a song. */
function job(key: string, songId: string | null, done: number, total: number): AnalysisJob {
  return {
    key,
    title: key,
    songId,
    stage: 'separating',
    segmentsDone: done,
    segmentsTotal: total,
    etaMs: 90_000,
    resumedFrom: 0,
  };
}

const nothing = {
  status: null,
  job: null,
  queue: emptyQueue<AnalysisItem>(),
  key: null,
  songId: null,
};

describe('analysisShare', () => {
  it('counts segments done against segments to do', () => {
    expect(analysisShare(0, 8)).toBe(0);
    expect(analysisShare(2, 8)).toBe(0.25);
    expect(analysisShare(8, 8)).toBe(1);
  });

  it('says nothing before the worker has counted the segments', () => {
    expect(analysisShare(0, 0)).toBeNull();
    expect(analysisShare(1, Number.NaN)).toBeNull();
  });

  it('stays inside the bar it is drawn in', () => {
    expect(analysisShare(9, 8)).toBe(1);
    expect(analysisShare(-1, 8)).toBe(0);
  });
});

describe('stageAnalysis', () => {
  it('finds nothing for a stage with nothing on it', () => {
    expect(stageAnalysis(nothing).phase).toBe('none');
  });

  it('follows the running job by the file it was queued under', () => {
    const view = stageAnalysis({
      ...nothing,
      status: 'separating',
      job: job('a', null, 2, 8),
      key: 'a',
    });
    expect(view.phase).toBe('running');
    expect(view.share).toBe(0.25);
    expect(view.etaMs).toBe(90_000);
  });

  it('follows it by song once the decode has said which song it is', () => {
    const view = stageAnalysis({
      ...nothing,
      status: 'separating',
      job: job('a', 'song-a', 4, 8),
      songId: 'song-a',
    });
    expect(view.phase).toBe('running');
    expect(view.share).toBe(0.5);
  });

  it('does not take another song\u2019s job for its own', () => {
    const view = stageAnalysis({
      ...nothing,
      status: 'ready',
      job: job('b', 'song-b', 4, 8),
      key: 'a',
      songId: 'song-a',
    });
    expect(view.phase).toBe('ready');
  });

  it('says where in the queue a song is waiting, and how many are behind it', () => {
    const view = stageAnalysis({
      ...nothing,
      status: 'separating',
      job: job('a', null, 1, 8),
      queue: queued('b', 'c', 'd'),
      key: 'c',
    });
    expect(view.phase).toBe('waiting');
    expect(view.place).toBe(2);
    expect(view.behind).toBe(2);
  });

  it('counts what is queued behind the song being analysed', () => {
    const started = startNext(queued('a', 'b', 'c'));
    const view = stageAnalysis({
      ...nothing,
      status: 'separating',
      job: job('a', null, 1, 8),
      queue: started,
      key: 'a',
    });
    expect(view.phase).toBe('running');
    expect(view.behind).toBe(2);
  });

  it('finds a waiting song by its record as well as by its file', () => {
    const queue = updateQueued(queued('a', 'b'), 'b', (waiting) => ({
      ...waiting,
      songId: 'song-b',
    }));
    expect(stageAnalysis({ ...nothing, queue, songId: 'song-b' }).place).toBe(2);
  });

  it('reads a stopped job, and one a closed tab left behind, as paused', () => {
    expect(stageAnalysis({ ...nothing, status: 'cancelled', songId: 'x' }).phase).toBe('paused');
    expect(stageAnalysis({ ...nothing, status: 'separating', songId: 'x' }).phase).toBe('paused');
  });

  it('reads a separated song as ready and a broken one as failed', () => {
    expect(stageAnalysis({ ...nothing, status: 'ready', songId: 'x' }).phase).toBe('ready');
    expect(stageAnalysis({ ...nothing, status: 'failed', songId: 'x' }).phase).toBe('failed');
  });
});

describe('describeAnalysis', () => {
  const view = (parts: Partial<AnalysisView>): AnalysisView => ({
    phase: 'running',
    share: null,
    etaMs: null,
    place: null,
    behind: 0,
    ...parts,
  });

  it('gives the percentage and the time left', () => {
    expect(describeAnalysis(view({ share: 0.25, etaMs: 120_000 }))).toBe(
      'analysing 25%, about 2 min left',
    );
  });

  it('says it is going before it knows how far', () => {
    expect(describeAnalysis(view({}))).toBe('analysing');
  });

  it('mentions the songs behind this one', () => {
    expect(describeAnalysis(view({ share: 0.5, behind: 2 }))).toBe('analysing 50%, 2 more queued');
  });

  it('counts a song off while it waits its turn', () => {
    expect(describeAnalysis(view({ phase: 'waiting', place: 2, behind: 1 }))).toBe(
      'queued for analysis, number 2, 1 more queued',
    );
  });

  it('promises a stopped job kept what it got through', () => {
    expect(describeAnalysis(view({ phase: 'paused' }))).toMatch(/kept/u);
  });
});

describe('vocalToggle', () => {
  const running = stageAnalysis({
    ...nothing,
    status: 'separating',
    job: job('a', null, 2, 8),
    key: 'a',
  });
  const ready = stageAnalysis({ ...nothing, status: 'ready', songId: 'x' });

  it('cannot be pressed while the song is still being analysed', () => {
    const toggle = vocalToggle(running, 'absent');
    expect(toggle.enabled).toBe(false);
    expect(toggle.label).toContain('analysing 25%');
  });

  it('cannot be pressed in the moment between the two, and says which it is', () => {
    expect(vocalToggle(ready, 'loading')).toEqual({
      enabled: false,
      label: 'reading the stems off this device',
    });
  });

  it('is ready once the stems are in memory, not merely written', () => {
    expect(vocalToggle(ready, 'ready').enabled).toBe(true);
  });

  it('says so when the stems are there but will not play', () => {
    const toggle = vocalToggle(ready, 'failed');
    expect(toggle.enabled).toBe(false);
    expect(toggle.label).toMatch(/could not be played/u);
  });

  it('explains a stopped analysis rather than a missing control', () => {
    const paused = stageAnalysis({ ...nothing, status: 'cancelled', songId: 'x' });
    expect(vocalToggle(paused, 'absent').label).toMatch(/needs analysis/u);
  });
});
