import { describe, expect, it } from 'vitest';

import {
  MAX_SCORE_HISTORY,
  appendScoreRun,
  bestScores,
  formatRunDate,
  normaliseScoreHistory,
  normaliseScoreRun,
  normaliseSinger,
  pruneScoreHistory,
  recentRuns,
  type PracticeRun,
} from '../src/practice/history.ts';

const AT = Date.UTC(2026, 10, 6, 12);

function run(patch: Partial<PracticeRun> = {}): PracticeRun {
  return {
    videoId: 'abcdefghijk',
    title: 'Blue Moon',
    artist: 'The Marcels',
    singer: null,
    score: 80,
    accuracy: 90,
    notesHit: 18,
    notesTotal: 20,
    longestStreak: 7,
    at: AT,
    ...patch,
  };
}

describe('normaliseScoreRun', () => {
  it('reads a complete record back', () => {
    const parsed = normaliseScoreRun({
      ...run({ singer: 'Lee' }),
      at: '2026-11-06T12:00:00.000Z',
    });

    expect(parsed).toEqual(run({ singer: 'Lee' }));
  });

  it('clamps numbers and trims the words it can read', () => {
    const parsed = normaliseScoreRun({
      videoId: 'abcdefghijk',
      title: '  Blue\nMoon  ',
      artist: '  The   Marcels ',
      singer: '  Lee  ',
      score: 140,
      accuracy: -10,
      notesHit: 90,
      notesTotal: 20,
      longestStreak: 900,
      at: AT,
    });

    expect(parsed?.title).toBe('Blue Moon');
    expect(parsed?.artist).toBe('The Marcels');
    expect(parsed?.singer).toBe('Lee');
    expect(parsed?.score).toBe(100);
    expect(parsed?.accuracy).toBe(0);
    expect(parsed?.notesHit).toBe(20);
    expect(parsed?.longestStreak).toBe(20);
  });

  it('drops a record that is not a score', () => {
    expect(
      normaliseScoreRun({
        videoId: 'not-a-video-id',
        title: 'Blue Moon',
        notesTotal: 20,
        at: AT,
      }),
    ).toBeNull();
    expect(normaliseScoreRun({ ...run(), title: '   ' })).toBeNull();
    expect(normaliseScoreRun({ ...run(), notesTotal: 0 })).toBeNull();
    expect(normaliseScoreRun({ ...run(), at: 'not a date' })).toBeNull();
    expect(normaliseScoreRun(null)).toBeNull();
  });

  it('bounds the title and the singer name', () => {
    const parsed = normaliseScoreRun({
      ...run(),
      title: 'x'.repeat(400),
      singer: 'y'.repeat(400),
    });

    expect(parsed?.title).toHaveLength(120);
    expect(parsed?.singer).toHaveLength(40);
  });
});

describe('normaliseScoreHistory', () => {
  it('drops malformed entries and keeps the newest records', () => {
    const old = run({ videoId: 'bbbbbbbbbbb', at: AT - 2_000 });
    const newer = run({ videoId: 'ccccccccccc', at: AT + 2_000 });
    const parsed = normaliseScoreHistory([old, { nope: true }, newer, run()]);

    expect(parsed.map((entry) => entry.videoId)).toEqual([
      'ccccccccccc',
      'abcdefghijk',
      'bbbbbbbbbbb',
    ]);
    expect(normaliseScoreHistory('nonsense')).toEqual([]);
  });
});

describe('sorting and ranking', () => {
  it('keeps the best run per song and sorts by score', () => {
    const best = bestScores([
      run({ videoId: 'aaaaaaaaaaa', title: 'A', score: 70 }),
      run({ videoId: 'bbbbbbbbbbb', title: 'B', score: 92 }),
      run({ videoId: 'aaaaaaaaaaa', title: 'A', score: 88 }),
      run({ videoId: 'ccccccccccc', title: 'C', score: 88, accuracy: 80 }),
      run({ videoId: 'ddddddddddd', title: 'D', score: 88, accuracy: 96 }),
    ]);

    expect(best.map((entry) => entry.videoId)).toEqual([
      'bbbbbbbbbbb',
      'ddddddddddd',
      'aaaaaaaaaaa',
      'ccccccccccc',
    ]);
    expect(best[0]?.score).toBe(92);
    expect(best[1]?.accuracy).toBe(96);
  });

  it('uses the newer run when score and accuracy are equal', () => {
    const best = bestScores([
      run({ videoId: 'aaaaaaaaaaa', at: AT - 10_000 }),
      run({ videoId: 'aaaaaaaaaaa', at: AT }),
    ]);

    expect(best).toHaveLength(1);
    expect(best[0]?.at).toBe(AT);
  });

  it('lists recent runs newest first and honours a limit', () => {
    const recent = recentRuns(
      [
        run({ at: AT - 1_000 }),
        run({ videoId: 'bbbbbbbbbbb', at: AT + 2_000 }),
        run({ videoId: 'ccccccccccc', at: AT + 1_000 }),
      ],
      2,
    );

    expect(recent.map((entry) => entry.at)).toEqual([AT + 2_000, AT + 1_000]);
    expect(bestScores([run()], 0)).toEqual([]);
    expect(recentRuns([run()], 0)).toEqual([]);
  });
});

describe('pruning', () => {
  it('appends a run and drops the oldest beyond the cap', () => {
    const history = [
      run({ videoId: 'aaaaaaaaaaa', at: AT - 3_000 }),
      run({ videoId: 'bbbbbbbbbbb', at: AT - 2_000 }),
      run({ videoId: 'ccccccccccc', at: AT - 1_000 }),
    ];
    const next = appendScoreRun(history, run({ videoId: 'ddddddddddd', at: AT }), 3);

    expect(next.map((entry) => entry.videoId)).toEqual([
      'ddddddddddd',
      'ccccccccccc',
      'bbbbbbbbbbb',
    ]);
  });

  it('caps a history that arrived too large', () => {
    const many = Array.from({ length: MAX_SCORE_HISTORY + 10 }, (_, index) =>
      run({ at: AT + index }),
    );

    expect(pruneScoreHistory(many)).toHaveLength(MAX_SCORE_HISTORY);
    expect(pruneScoreHistory(many)[0]?.at).toBe(AT + MAX_SCORE_HISTORY + 9);
    expect(pruneScoreHistory(many, 0)).toEqual([]);
  });
});

describe('formatRunDate', () => {
  it('writes the date in UTC', () => {
    expect(formatRunDate(Date.UTC(2026, 10, 6, 23, 30))).toBe('6 Nov 2026');
    expect(formatRunDate(Number.NaN)).toBe('—');
  });
});

describe('normaliseSinger', () => {
  it('keeps one bounded line, or nothing', () => {
    expect(normaliseSinger('  Lee   Guan  ')).toBe('Lee Guan');
    expect(normaliseSinger('')).toBe('');
    expect(normaliseSinger(42)).toBe('');
    expect(normaliseSinger('x'.repeat(80))).toHaveLength(40);
  });
});
