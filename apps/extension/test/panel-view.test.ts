import { describe, expect, it } from 'vitest';

import {
  delayNote,
  guideFromPercent,
  guidePercent,
  panelView,
  TOOLBAR_HINT,
} from '../src/content/panel-view.ts';
import type { Status, StatusReport } from '../src/protocol.ts';

function reported(status: Status, rest: Partial<StatusReport> = {}): StatusReport {
  return {
    type: 'status',
    status,
    reason: null,
    secondsLeft: null,
    delaySeconds: null,
    mode: 'instrumental',
    guide: 0,
    ...rest,
  };
}

describe('panelView', () => {
  it('offers nothing but the button before anything has started', () => {
    const view = panelView({ report: null });

    expect(view.state).toBe('off');
    expect(view.label).toBe('Karaoke');
    expect(view.detail).toBeNull();
    expect(view.controls).toBe(false);
  });

  it('shows the hint while off, because starting is not the panel to give', () => {
    const view = panelView({ report: reported('idle'), hint: TOOLBAR_HINT });

    expect(view.state).toBe('off');
    expect(view.detail).toBe(TOOLBAR_HINT);
  });

  it('counts the prime down from when the report was sent', () => {
    const report = reported('priming', { secondsLeft: 18 });

    expect(panelView({ report, sinceMs: 0 }).label).toBe('Preparing 18 s');
    expect(panelView({ report, sinceMs: 5500 }).label).toBe('Preparing 13 s');
    // And stops at zero rather than going negative between reports.
    expect(panelView({ report, sinceMs: 90_000 }).label).toBe('Preparing 0 s');
  });

  it('says it is preparing without a number when there is none', () => {
    expect(panelView({ report: reported('priming') }).label).toBe('Preparing');
  });

  it('passes on what is taking so long, which is usually the model', () => {
    const view = panelView({
      report: reported('priming', { secondsLeft: 18, reason: 'loading the model, 3 of 21' }),
    });

    expect(view.detail).toBe('loading the model, 3 of 21');
    expect(view.controls).toBe(false);
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

  it('says nothing when there is no delay to speak of', () => {
    expect(delayNote(null)).toBeNull();
    expect(delayNote(0)).toBeNull();
    expect(delayNote(Number.NaN)).toBeNull();
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
