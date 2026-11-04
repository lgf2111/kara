import { describe, expect, it } from 'vitest';

import { NO_TIMINGS, prepareProgress, WINDOW_SECONDS } from '../src/audio/progress.ts';
import {
  delayNote,
  guideFromPercent,
  guidePercent,
  jumpedBackNote,
  panelView,
  prepareDetail,
  reprimeNote,
  TOOLBAR_HINT,
} from '../src/content/panel-view.ts';
import type { PrepareProgress, Status, StatusReport } from '../src/protocol.ts';

function reported(status: Status, rest: Partial<StatusReport> = {}): StatusReport {
  return {
    type: 'status',
    status,
    reason: null,
    prepare: null,
    reprime: null,
    delaySeconds: null,
    heldSeconds: 0,
    catchUp: null,
    waitingForPlay: false,
    mode: 'instrumental',
    guide: 0,
    semitones: 0,
    onReady: 'restart',
    ...rest,
  };
}

/** A prime partway through loading the model, which is where it starts. */
function loading(loaded: number): PrepareProgress {
  return prepareProgress({
    modelPieces: { loaded, total: 21 },
    loadingSeconds: 3,
    listenedSeconds: null,
    windowSeconds: WINDOW_SECONDS,
    separatingSeconds: null,
    expectedSeparateSeconds: 5.85,
    fillingSeconds: null,
    fillSeconds: 1.5,
    timings: NO_TIMINGS,
  });
}

describe('panelView', () => {
  it('offers nothing but the button before anything has started', () => {
    const view = panelView({ report: null });

    expect(view.state).toBe('off');
    expect(view.label).toBe('Karaoke');
    expect(view.detail).toBeNull();
    expect(view.progress).toBeNull();
    expect(view.controls).toBe(false);
  });

  it('shows the hint while off, because starting is not the panel to give', () => {
    const view = panelView({ report: reported('idle'), hint: TOOLBAR_HINT });

    expect(view.state).toBe('off');
    expect(view.detail).toBe(TOOLBAR_HINT);
  });

  /**
   * There used to be a countdown here, and it lied: it froze at 15.5 s through
   * the model loading and reached nought twelve seconds before there was
   * anything to hear. What replaced it is a bar out of the report, which the
   * panel does not extrapolate.
   */
  it('shows a bar and the stage rather than a countdown', () => {
    const view = panelView({ report: reported('priming', { prepare: loading(3) }) });

    expect(view.state).toBe('preparing');
    expect(view.label).toBe('Preparing');
    expect(view.progress).toBeCloseTo(0.45 * (3 / 21), 9);
    expect(view.detail).toBe('Loading the model, 3 of 21');
    expect(view.controls).toBe(false);
  });

  it('says how long is left only once the stages have been timed', () => {
    const timed = prepareProgress({
      modelPieces: null,
      loadingSeconds: 10,
      listenedSeconds: 0,
      windowSeconds: WINDOW_SECONDS,
      separatingSeconds: null,
      expectedSeparateSeconds: 5.85,
      fillingSeconds: null,
      fillSeconds: 1.5,
      timings: { loading: 10, listening: WINDOW_SECONDS, separating: 8, filling: 1.5 },
    });

    expect(prepareDetail(reported('priming', { prepare: timed }))).toBe(
      'Listening to the first few seconds · about 17 s left',
    );
  });

  it('shows a bar at nothing rather than no bar when the report has no progress', () => {
    expect(panelView({ report: reported('priming') }).progress).toBe(0);
  });

  it('explains the bar starting over, because that reads as a crash', () => {
    const view = panelView({
      report: reported('priming', { prepare: loading(1), reprime: 'seek' }),
    });

    expect(view.note).toBe('You jumped; preparing again');
  });

  it('says a pause has lost nothing, and keeps the controls it has audio for', () => {
    const paused = panelView({ report: reported('paused', { delaySeconds: 17.5 }) });

    expect(paused.state).toBe('paused');
    expect(paused.label).toBe('Paused');
    expect(paused.detail).toBe('nothing lost; it carries on from here');
    expect(paused.progress).toBeNull();
    expect(paused.controls).toBe(true);
    // Paused before there was ever any audio: nothing to control yet.
    expect(panelView({ report: reported('paused') }).controls).toBe(false);
  });

  it('offers the controls only once there is audio to control', () => {
    const view = panelView({
      report: reported('live', { delaySeconds: 17.5, mode: 'original', guide: 0.4 }),
    });

    expect(view.state).toBe('live');
    expect(view.label).toBe('Karaoke on');
    expect(view.controls).toBe(true);
    expect(view.mode).toBe('original');
    expect(view.guide).toBe(40);
    // Without this the delay reads as a broken page.
    expect(view.detail).toBe('picture is 18 s behind YouTube');
  });

  it('carries the key and its words out of the report', () => {
    const view = panelView({ report: reported('live', { delaySeconds: 17.5, semitones: -2 }) });

    expect(view.semitones).toBe(-2);
    expect(view.keyLabel).toBe('Key −2');
  });

  it('says the original key before anybody has moved it', () => {
    expect(panelView({ report: null }).semitones).toBe(0);
    expect(panelView({ report: null }).keyLabel).toBe('Original key');
    // Whatever a report from some other version of this extension said.
    expect(panelView({ report: reported('live', { semitones: 40 }) }).semitones).toBe(6);
  });

  it('says the picture jumped back, for as long as the caller asks', () => {
    const live = reported('live', { delaySeconds: 18, onReady: 'continue' });

    expect(panelView({ report: live, jumped: true }).note).toBe('jumped back 18 s');
    expect(panelView({ report: live }).note).toBeNull();
  });

  it('keeps the reason a machine cannot do this, and offers no controls', () => {
    const view = panelView({
      report: reported('unsupported', { reason: 'this browser has no WebGPU adapter' }),
    });

    expect(view.state).toBe('unsupported');
    expect(view.label).toBe('Unavailable');
    expect(view.detail).toBe('this browser has no WebGPU adapter');
    expect(view.controls).toBe(false);
  });

  it('never leaves a failure unexplained', () => {
    const view = panelView({ report: reported('error') });

    expect(view.state).toBe('error');
    expect(view.detail).toBe('no reason given');
  });

  it('forgets the hint as soon as something is running', () => {
    const view = panelView({ report: reported('priming'), hint: TOOLBAR_HINT });

    expect(view.detail).toBeNull();
  });
});

describe('delayNote', () => {
  it('rounds to whole seconds, because nobody needs the half', () => {
    expect(delayNote(17.5)).toBe('picture is 18 s behind YouTube');
    expect(delayNote(16)).toBe('picture is 16 s behind YouTube');
  });

  it('counts the pauses in, because the picture is behind by those too', () => {
    expect(delayNote(17.5, 10.2)).toBe('picture is 28 s behind YouTube');
  });

  it('says nothing when there is no delay to speak of', () => {
    expect(delayNote(null)).toBeNull();
    expect(delayNote(0)).toBeNull();
    expect(delayNote(Number.NaN)).toBeNull();
  });
});

describe('the notes', () => {
  it('has a sentence for every reason a prime can start again', () => {
    for (const reason of ['seek', 'ratechange', 'navigation', 'ended', 'ad'] as const) {
      expect(reprimeNote(reason)).toMatch(/\w/u);
    }
    expect(reprimeNote(null)).toBeNull();
  });

  it('says how far the picture jumped, or nothing at all', () => {
    expect(jumpedBackNote(18)).toBe('jumped back 18 s');
    expect(jumpedBackNote(null)).toBeNull();
    expect(jumpedBackNote(0)).toBeNull();
  });
});

describe('the guide slider', () => {
  it('goes from a gain to a position and back', () => {
    expect(guidePercent(0)).toBe(0);
    expect(guidePercent(0.35)).toBe(35);
    expect(guidePercent(1)).toBe(100);
    expect(guideFromPercent(35)).toBeCloseTo(0.35, 9);
  });

  it('stays inside the slider, whatever it is handed', () => {
    expect(guidePercent(4)).toBe(100);
    expect(guidePercent(-1)).toBe(0);
    expect(guidePercent(Number.NaN)).toBe(0);
    expect(guideFromPercent(400)).toBe(1);
    expect(guideFromPercent(-20)).toBe(0);
    expect(guideFromPercent(Number.NaN)).toBe(0);
  });
});
