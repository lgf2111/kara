import { describe, expect, it } from 'vitest';

import {
  aboutText,
  advanceProgress,
  fractionAt,
  NO_TIMINGS,
  prepareLabel,
  prepareProgress,
  progressPercent,
  stageOf,
  STAGE_WEIGHTS,
  type PrepareFacts,
} from '../src/audio/progress.ts';

function facts(patch: Partial<PrepareFacts> = {}): PrepareFacts {
  return {
    download: null,
    pieces: null,
    windowsDone: 0,
    windowsTotal: 0,
    elapsedSeconds: 0,
    timings: { ...NO_TIMINGS },
    ...patch,
  };
}

describe('the bar', () => {
  it('is split into the three things that happen, and sums to one', () => {
    expect(STAGE_WEIGHTS.download).toBeCloseTo(0.1);
    expect(STAGE_WEIGHTS.loading).toBeCloseTo(0.4);
    expect(STAGE_WEIGHTS.separating).toBeCloseTo(0.5);
    expect(STAGE_WEIGHTS.download + STAGE_WEIGHTS.loading + STAGE_WEIGHTS.separating).toBeCloseTo(1);
  });

  it('starts each stage where the last one ended', () => {
    expect(fractionAt('download', 0)).toBeCloseTo(0);
    expect(fractionAt('download', 1)).toBeCloseTo(0.1);
    expect(fractionAt('loading', 0)).toBeCloseTo(0.1);
    expect(fractionAt('loading', 1)).toBeCloseTo(0.5);
    expect(fractionAt('separating', 0)).toBeCloseTo(0.5);
    expect(fractionAt('separating', 1)).toBeCloseTo(1);
  });

  it('is about the work, not about a guess', () => {
    const halfway = prepareProgress(
      facts({ windowsTotal: 20, windowsDone: 10 }),
    );

    expect(halfway.stage).toBe('separating');
    expect(halfway.fraction).toBeCloseTo(0.75);
  });
});

describe('stageOf', () => {
  it('reads the first thing that has not finished', () => {
    expect(stageOf(facts())).toBe('download');
    expect(stageOf(facts({ pieces: { loaded: 1, total: 21 } }))).toBe('loading');
    expect(
      stageOf(facts({ pieces: { loaded: 21, total: 21 }, windowsTotal: 9, windowsDone: 0 })),
    ).toBe('separating');
  });
});

describe('the download', () => {
  it('is a ratio of bytes when the length is known', () => {
    const progress = prepareProgress(
      facts({ download: { doneBytes: 250, totalBytes: 1000 } }),
    );

    expect(progress.fraction).toBeCloseTo(0.025);
  });

  it('creeps towards its edge when the length is not known, and never arrives', () => {
    const atStart = prepareProgress(facts({ download: { doneBytes: 10, totalBytes: null } }));
    const later = prepareProgress(
      facts({ download: { doneBytes: 10, totalBytes: null }, elapsedSeconds: 30 }),
    );

    expect(atStart.fraction).toBeCloseTo(0);
    expect(later.fraction).toBeGreaterThan(atStart.fraction);
    expect(later.fraction).toBeLessThan(STAGE_WEIGHTS.download);
  });
});

describe('loading the model', () => {
  it('is a ratio of pieces, and says how many', () => {
    const progress = prepareProgress(facts({ pieces: { loaded: 7, total: 21 } }));

    expect(progress.stage).toBe('loading');
    expect(progress.pieces).toEqual({ loaded: 7, total: 21 });
    expect(progress.fraction).toBeCloseTo(0.1 + 0.4 * (7 / 21));
    expect(prepareLabel(progress)).toBe('Loading the model, 7 of 21');
  });
});

describe('separating', () => {
  it('is a ratio of windows, and reports the count it is waiting on', () => {
    const progress = prepareProgress(
      facts({ windowsTotal: 40, windowsDone: 10, timings: { ...NO_TIMINGS, windowMs: 1000 } }),
    );

    expect(progress.stage).toBe('separating');
    expect(progress.fraction).toBeCloseTo(0.5 + 0.5 * 0.25);
    expect(prepareLabel(progress)).toBe('Taking the vocal out');
  });

  it('offers a time only once a window has actually been timed', () => {
    const unmeasured = prepareProgress(facts({ windowsTotal: 40, windowsDone: 10 }));
    const measured = prepareProgress(
      facts({ windowsTotal: 40, windowsDone: 10, timings: { ...NO_TIMINGS, windowMs: 500 } }),
    );

    expect(unmeasured.aboutSeconds).toBeNull();
    expect(measured.aboutSeconds).toBeCloseTo(15);
    expect(aboutText(measured)).toBe('about 15 s left');
  });

  it('says a second rather than zero when there is almost none left', () => {
    const progress = prepareProgress(
      facts({ windowsTotal: 10, windowsDone: 9, timings: { ...NO_TIMINGS, windowMs: 200 } }),
    );

    expect(aboutText(progress)).toBe('about a second left');
  });

  it('has no estimate at all before the plan is known, however the machine was timed', () => {
    const progress = prepareProgress(
      facts({ pieces: { loaded: 3, total: 21 }, timings: { ...NO_TIMINGS, windowMs: 500 } }),
    );

    expect(progress.aboutSeconds).toBeNull();
    expect(aboutText(progress)).toBeNull();
  });
});

describe('advanceProgress', () => {
  it('never lets the bar retreat, because a measured wobble reads as a fault', () => {
    const first = prepareProgress(facts({ windowsTotal: 10, windowsDone: 5 }));
    const second = prepareProgress(facts({ windowsTotal: 10, windowsDone: 4 }));

    expect(advanceProgress(first, second).fraction).toBe(first.fraction);
    // Everything else still comes from the new measurement.
    expect(advanceProgress(first, second).stage).toBe('separating');
  });

  it('starts from wherever it is given when there is nothing before it', () => {
    const next = prepareProgress(facts({ windowsTotal: 10, windowsDone: 5 }));

    expect(advanceProgress(null, next)).toBe(next);
  });
});

describe('progressPercent', () => {
  it('is a whole number for a style and for aria', () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(0.754)).toBe(75);
    expect(progressPercent(1)).toBe(100);
  });

  it('clamps rather than letting a bad measurement widen the bar', () => {
    expect(progressPercent(-2)).toBe(0);
    expect(progressPercent(4)).toBe(100);
    expect(progressPercent(Number.NaN)).toBe(0);
  });
});
