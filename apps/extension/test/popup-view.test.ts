import { describe, expect, it } from 'vitest';

import { NO_TIMINGS, prepareProgress, WINDOW_SECONDS } from '../src/audio/progress.ts';
import {
  captureBlock,
  ON_READY_CHOICES,
  pageNote,
  popupView,
} from '../src/popup/popup-view.ts';
import type { Status, StatusReport } from '../src/protocol.ts';

const YOUTUBE = 'https://www.youtube.com/watch?v=x';

function reported(status: Status, rest: Partial<StatusReport> = {}): StatusReport {
  return {
    type: 'status',
    status,
    reason: null,
    prepare: null,
    reprime: null,
    delaySeconds: null,
    heldSeconds: 0,
    mode: 'instrumental',
    guide: 0,
    onReady: 'restart',
    ...rest,
  };
}

describe('captureBlock', () => {
  it('lets a page through', () => {
    expect(captureBlock(YOUTUBE)).toBeNull();
    expect(captureBlock('http://localhost:5276/test/page.html')).toBeNull();
  });

  it('refuses what Chrome refuses, rather than offering a button that fails', () => {
    expect(captureBlock('chrome://extensions')).toMatch(/does not allow/u);
    expect(captureBlock('about:blank')).toMatch(/does not allow/u);
    expect(captureBlock(undefined)).toMatch(/no page/u);
    expect(captureBlock('nonsense')).toMatch(/no page/u);
  });
});

describe('pageNote', () => {
  it('says nothing where the panel works', () => {
    expect(pageNote(YOUTUBE)).toBeNull();
    expect(pageNote('http://localhost:5276/test/page.html')).toBeNull();
  });

  it('says what is missing elsewhere, since the audio still works', () => {
    expect(pageNote('https://example.com/song')).toMatch(/only work on YouTube/u);
  });
});

describe('popupView', () => {
  it('offers a start on a tab that can be captured', () => {
    const view = popupView({ report: null, url: YOUTUBE, onReady: 'restart' });

    expect(view.state).toBe('idle');
    expect(view.action).toBe('start');
    expect(view.actionLabel).toBe('Start');
    expect(view.progress).toBeNull();
  });

  it('offers nothing on a tab that cannot, and says why', () => {
    const view = popupView({ report: null, url: 'chrome://newtab', onReady: 'restart' });

    expect(view.state).toBe('unsupported');
    expect(view.action).toBe('none');
    expect(view.detail).toMatch(/does not allow/u);
  });

  it('shows the same bar the panel shows, from the same report', () => {
    const prepare = prepareProgress({
      modelPieces: { loaded: 7, total: 21 },
      loadingSeconds: 4,
      listenedSeconds: null,
      windowSeconds: WINDOW_SECONDS,
      separatingSeconds: null,
      expectedSeparateSeconds: 5.85,
      fillingSeconds: null,
      fillSeconds: 1.5,
      timings: NO_TIMINGS,
    });
    const view = popupView({
      report: reported('priming', { prepare }),
      url: YOUTUBE,
      onReady: 'restart',
    });

    expect(view.state).toBe('preparing');
    expect(view.progress).toBeCloseTo(0.15, 9);
    expect(view.detail).toBe('Loading the model, 7 of 21');
    expect(view.action).toBe('stop');
  });

  it('explains a prime that started over', () => {
    const view = popupView({
      report: reported('priming', { reprime: 'seek' }),
      url: YOUTUBE,
      onReady: 'restart',
    });

    expect(view.detail).toBe('You jumped; preparing again.');
  });

  it('says it is live and how far behind the picture is', () => {
    const view = popupView({
      report: reported('live', { delaySeconds: 17.5 }),
      url: YOUTUBE,
      onReady: 'restart',
    });

    expect(view.state).toBe('live');
    expect(view.headline).toBe('Live');
    expect(view.detail).toBe('picture is 18 s behind YouTube');
  });

  it('says a pause has lost nothing', () => {
    const view = popupView({
      report: reported('paused', { delaySeconds: 17.5 }),
      url: YOUTUBE,
      onReady: 'restart',
    });

    expect(view.state).toBe('paused');
    expect(view.detail).toMatch(/nothing lost/u);
    expect(view.action).toBe('stop');
  });

  it('keeps the reason a machine cannot do it, and still offers a stop', () => {
    const view = popupView({
      report: reported('unsupported', { reason: 'no WebGPU adapter' }),
      url: YOUTUBE,
      onReady: 'restart',
    });

    expect(view.state).toBe('unsupported');
    expect(view.detail).toBe('no WebGPU adapter');
    expect(view.action).toBe('stop');
  });

  it('takes the setting from the running capture over the stored one', () => {
    const view = popupView({
      report: reported('live', { onReady: 'continue' }),
      url: YOUTUBE,
      onReady: 'restart',
    });

    expect(view.onReady).toBe('continue');
  });

  it('falls back to the stored setting when nothing is running', () => {
    expect(popupView({ report: null, url: YOUTUBE, onReady: 'continue' }).onReady).toBe(
      'continue',
    );
  });
});

describe('the two choices', () => {
  it('are both of them, each with words of its own', () => {
    expect(ON_READY_CHOICES.map((choice) => choice.value)).toEqual(['restart', 'continue']);
    for (const choice of ON_READY_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(10);
    }
  });

  it('says that continuing means jumping back, because it does', () => {
    expect(ON_READY_CHOICES[1]?.label).toMatch(/jumps back/u);
  });
});
