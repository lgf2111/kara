import { describe, expect, it } from 'vitest';

import {
  aboutText,
  advanceProgress,
  NO_TIMINGS,
  prepareLabel,
  prepareProgress,
  PREPARE_STAGES,
  progressPercent,
  stageOf,
  stageSpan,
  STAGE_WEIGHTS,
  WINDOW_SECONDS,
  type PrepareFacts,
  type StageSeconds,
} from '../src/audio/progress.ts';

/** A first prime: nothing measured, nothing loaded, nothing heard. */
const FRESH: PrepareFacts = {
  modelPieces: null,
  loadingSeconds: 0,
  listenedSeconds: null,
  windowSeconds: WINDOW_SECONDS,
  separatingSeconds: null,
  expectedSeparateSeconds: 5.85,
  fillingSeconds: null,
  fillSeconds: 1.5,
  timings: NO_TIMINGS,
};

/** What a machine knows about itself after one prime. */
const MEASURED: StageSeconds = {
  loading: 10,
  listening: WINDOW_SECONDS,
  separating: 8,
  filling: 1.5,
};

describe('the stages', () => {
  it('divide the bar between them and nothing else', () => {
    const total = PREPARE_STAGES.reduce((sum, stage) => sum + STAGE_WEIGHTS[stage], 0);

    expect(total).toBeCloseTo(1, 9);
  });

  it('own the slices the panel and the popup were built around', () => {
    expect(stageSpan('loading')).toEqual({ from: 0, size: 0.45 });
    expect(stageSpan('listening')).toEqual({ from: 0.45, size: 0.25 });
    expect(stageSpan('separating')).toEqual({ from: 0.7, size: 0.15 });
    expect(stageSpan('filling')).toEqual({ from: 0.85, size: 0.15 });
  });
});

describe('stageOf', () => {
  it('is loading until the separator says it is ready', () => {
    expect(stageOf(FRESH)).toBe('loading');
    expect(stageOf({ ...FRESH, modelPieces: { loaded: 20, total: 21 } })).toBe('loading');
  });

  it('is listening as soon as there is a clock, which is a later prime', () => {
    expect(stageOf({ ...FRESH, listenedSeconds: 0 })).toBe('listening');
  });

  it('is separating once a whole window has been heard', () => {
    const facts = { ...FRESH, listenedSeconds: WINDOW_SECONDS, separatingSeconds: 0 };

    expect(stageOf(facts)).toBe('separating');
  });

  it('is filling once the first block has fixed the delay', () => {
    const facts = {
      ...FRESH,
      listenedSeconds: WINDOW_SECONDS,
      separatingSeconds: 8,
      fillingSeconds: 0,
    };

    expect(stageOf(facts)).toBe('filling');
  });
});

describe('prepareProgress', () => {
  it('counts the model out of its pieces, across the first slice', () => {
    expect(prepareProgress(FRESH).fraction).toBe(0);
    expect(
      prepareProgress({ ...FRESH, modelPieces: { loaded: 21, total: 21 } }).fraction,
    ).toBeCloseTo(0.45, 9);
    expect(
      prepareProgress({ ...FRESH, modelPieces: { loaded: 7, total: 21 } }).fraction,
    ).toBeCloseTo(0.15, 9);
  });

  it('starts a later prime at the listening stage, with the model behind it', () => {
    const later = prepareProgress({ ...FRESH, listenedSeconds: 0, timings: MEASURED });

    expect(later.stage).toBe('listening');
    expect(later.fraction).toBeCloseTo(0.45, 9);
  });

  it('fills the listening slice with the audio the separator needs', () => {
    const half = prepareProgress({ ...FRESH, listenedSeconds: WINDOW_SECONDS / 2 });

    expect(half.fraction).toBeCloseTo(0.575, 9);
  });

  it('approaches the separating slice without ever sitting on its edge', () => {
    const at = (seconds: number): number =>
      prepareProgress({
        ...FRESH,
        listenedSeconds: WINDOW_SECONDS,
        separatingSeconds: seconds,
      }).fraction;

    expect(at(0)).toBeCloseTo(0.7, 9);
    // At the guess it is most of the way across, and at four times the guess
    // it is still moving: a machine slower than the guess never sees a bar
    // that has stopped.
    expect(at(5.85)).toBeGreaterThan(0.82);
    expect(at(5.85)).toBeLessThan(0.85);
    expect(at(23.4)).toBeLessThan(0.85);
    expect(at(23.4)).toBeGreaterThan(at(11.7));
    expect(at(11.7)).toBeGreaterThan(at(5.85));
  });

  it('reaches one exactly when the first block is due', () => {
    const done = prepareProgress({
      ...FRESH,
      listenedSeconds: WINDOW_SECONDS,
      separatingSeconds: 8,
      fillingSeconds: 1.5,
      fillSeconds: 1.5,
    });

    expect(done.stage).toBe('filling');
    expect(done.fraction).toBe(1);
  });

  it('never leaves the bar, whatever it is handed', () => {
    const silly = prepareProgress({
      ...FRESH,
      modelPieces: { loaded: 99, total: 0 },
      loadingSeconds: Number.NaN,
    });

    expect(silly.fraction).toBeGreaterThanOrEqual(0);
    expect(silly.fraction).toBeLessThanOrEqual(1);
  });
});

describe('the estimate', () => {
  it('is nothing at all on a machine that has never done this', () => {
    expect(prepareProgress(FRESH).aboutSeconds).toBeNull();
    expect(prepareProgress({ ...FRESH, listenedSeconds: 1 }).aboutSeconds).toBeNull();
  });

  it('totals what is left here with what the stages ahead have cost', () => {
    const facts = { ...FRESH, listenedSeconds: 0, timings: MEASURED };

    // 7.8 s of audio still to hear, then eight seconds of separating and a
    // second and a half of waiting, all of them measured.
    expect(prepareProgress(facts).aboutSeconds).toBeCloseTo(17.3, 6);
  });

  it('is exact in the last stage, even the first time through', () => {
    const facts = { ...FRESH, listenedSeconds: 8, separatingSeconds: 8, fillingSeconds: 0.5 };

    expect(prepareProgress(facts).aboutSeconds).toBeCloseTo(1, 9);
  });

  it('goes missing again when the stage ahead has not been timed', () => {
    const half: StageSeconds = { ...MEASURED, separating: null };
    const facts = { ...FRESH, listenedSeconds: 0, timings: half };

    expect(prepareProgress(facts).aboutSeconds).toBeNull();
  });

  it('says about, because that is what a measured average is', () => {
    const facts = { ...FRESH, listenedSeconds: 0, timings: MEASURED };

    expect(aboutText(prepareProgress(facts))).toBe('about 17 s left');
    expect(aboutText(prepareProgress(FRESH))).toBeNull();
  });

  it('does not say nought seconds when there is a moment left', () => {
    const facts = { ...FRESH, listenedSeconds: 8, separatingSeconds: 8, fillingSeconds: 1.49 };

    expect(aboutText(prepareProgress(facts))).toBe('about a second left');
  });
});

describe('advanceProgress', () => {
  it('lets the bar climb', () => {
    const first = prepareProgress({ ...FRESH, modelPieces: { loaded: 2, total: 21 } });
    const second = prepareProgress({ ...FRESH, modelPieces: { loaded: 9, total: 21 } });

    expect(advanceProgress(first, second).fraction).toBe(second.fraction);
  });

  it('refuses to let it fall back, whatever the measurements do', () => {
    const ahead = prepareProgress({
      ...FRESH,
      listenedSeconds: WINDOW_SECONDS,
      separatingSeconds: 20,
    });
    const behind = prepareProgress({
      ...FRESH,
      listenedSeconds: WINDOW_SECONDS,
      separatingSeconds: 1,
    });
    const held = advanceProgress(ahead, behind);

    expect(held.fraction).toBe(ahead.fraction);
    // The stage is still whatever is really happening; only the bar is held.
    expect(held.stage).toBe(behind.stage);
  });

  it('starts again from nothing when a reset passes null', () => {
    const anywhere = prepareProgress({ ...FRESH, listenedSeconds: 4 });
    const fresh = prepareProgress({ ...FRESH, listenedSeconds: 0 });

    expect(advanceProgress(null, fresh).fraction).toBe(fresh.fraction);
    expect(advanceProgress(anywhere, fresh).fraction).toBe(anywhere.fraction);
  });
});

describe('prepareLabel', () => {
  it('names the pieces, because that is the slow part and it is countable', () => {
    const loading = prepareProgress({ ...FRESH, modelPieces: { loaded: 3, total: 21 } });

    expect(prepareLabel(loading)).toBe('Loading the model, 3 of 21');
  });

  it('says what each of the other stages is waiting for', () => {
    expect(prepareLabel(prepareProgress({ ...FRESH, listenedSeconds: 1 }))).toBe(
      'Listening to the first few seconds',
    );
    expect(
      prepareLabel(
        prepareProgress({ ...FRESH, listenedSeconds: WINDOW_SECONDS, separatingSeconds: 1 }),
      ),
    ).toBe('Taking the vocal out');
    expect(
      prepareLabel(
        prepareProgress({
          ...FRESH,
          listenedSeconds: WINDOW_SECONDS,
          separatingSeconds: 8,
          fillingSeconds: 0.2,
        }),
      ),
    ).toBe('Filling the delay');
  });
});

describe('progressPercent', () => {
  it('is a whole percentage, for a style and for aria', () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(0.456)).toBe(46);
    expect(progressPercent(1)).toBe(100);
  });

  it('stays on the bar', () => {
    expect(progressPercent(4)).toBe(100);
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(Number.NaN)).toBe(0);
  });
});
