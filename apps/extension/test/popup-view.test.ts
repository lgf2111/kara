import { describe, expect, it } from 'vitest';

import { NO_TIMINGS, prepareProgress, WINDOW_SECONDS } from '../src/audio/progress.ts';
import {
  captureBlock,
  ON_READY_CHOICES,
  pageNote,
  popupView,
  type PopupInput,
  type PopupView,
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
    catchUp: null,
    waitingForPlay: false,
    mode: 'instrumental',
    guide: 0,
    semitones: 0,
    onReady: 'restart',
    ...rest,
  };
}

/** The stored defaults, which a test only mentions when they are the point. */
function shown(input: Partial<PopupInput>): PopupView {
  return popupView({ report: null, url: YOUTUBE, onReady: 'restart', key: 0, ...input });
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
    const view = shown({});

    expect(view.state).toBe('idle');
    expect(view.action).toBe('start');
    expect(view.actionLabel).toBe('Start');
    expect(view.progress).toBeNull();
  });

  it('offers nothing on a tab that cannot, and says why', () => {
    const view = shown({ url: 'chrome://newtab' });

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
    const view = shown({ report: reported('priming', { prepare }) });

    expect(view.state).toBe('preparing');
    expect(view.progress).toBeCloseTo(0.15, 9);
    expect(view.detail).toBe('Loading the model, 7 of 21');
    expect(view.action).toBe('stop');
  });

  it('explains a prime that started over', () => {
    const view = shown({ report: reported('priming', { reprime: 'seek' }) });

    expect(view.detail).toBe('You jumped; preparing again.');
  });

  it('says it is live and how far behind the picture is', () => {
    const view = shown({ report: reported('live', { delaySeconds: 17.5 }) });

    expect(view.state).toBe('live');
    expect(view.headline).toBe('Live');
    expect(view.detail).toBe('picture is 18 s behind YouTube');
  });

  it('says a pause has lost nothing', () => {
    const view = shown({ report: reported('paused', { delaySeconds: 17.5 }) });

    expect(view.state).toBe('paused');
    expect(view.detail).toMatch(/nothing lost/u);
    expect(view.action).toBe('stop');
  });

  it('keeps the reason a machine cannot do it, and still offers a stop', () => {
    const view = shown({ report: reported('unsupported', { reason: 'no WebGPU adapter' }) });

    expect(view.state).toBe('unsupported');
    expect(view.detail).toBe('no WebGPU adapter');
    expect(view.action).toBe('stop');
  });

  it('takes the setting from the running capture over the stored one', () => {
    const view = shown({ report: reported('live', { onReady: 'continue' }) });

    expect(view.onReady).toBe('continue');
  });

  it('falls back to the stored setting when nothing is running', () => {
    expect(shown({ onReady: 'continue' }).onReady).toBe('continue');
  });
});

describe('the key', () => {
  it('shows the remembered default when nothing is running', () => {
    const view = shown({ key: -2 });

    expect(view.semitones).toBe(-2);
    expect(view.keyLabel).toBe('Key −2');
  });

  /**
   * Because the panel in the page can move the key without touching the
   * default, and what a person wants to see in the popup is what they are
   * listening to rather than what they will be listening to next time.
   */
  it('shows what the capture is playing in over the remembered default', () => {
    const view = shown({ report: reported('live', { semitones: 3 }), key: -2 });

    expect(view.semitones).toBe(3);
    expect(view.keyLabel).toBe('Key +3');
  });

  it('says the original key when nothing has moved', () => {
    expect(shown({}).keyLabel).toBe('Original key');
  });

  it('stays inside the range, whatever was stored', () => {
    expect(shown({ key: 40 }).semitones).toBe(6);
    expect(shown({ key: Number.NaN }).semitones).toBe(0);
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
