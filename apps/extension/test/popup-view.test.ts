import { describe, expect, it } from 'vitest';

import { DEFAULT_MIX, withMute, withSolo, withStem } from '../src/audio/stems.ts';
import { pageNote, popupView } from '../src/popup/popup-view.ts';
import { NO_METRICS, type PipelineDebug } from '../src/protocol.ts';
import { report } from './report.ts';

const YOUTUBE = 'https://www.youtube.com/watch?v=abc123';

const PIPELINE: PipelineDebug = {
  atMs: 1,
  status: 'preparing',
  reason: null,
  sampleRate: 48_000,
  metrics: {
    ...NO_METRICS,
    mediaSeconds: 12.4,
    stemFrames: 2_169_600,
    windowsDone: 3,
    windowsTotal: 9,
    computeMs: 1250,
    downloadBytes: 3_200_000,
    downloadTotal: 5_000_000,
  },
  videoId: 'abc12345678',
  durationSeconds: 213,
  backend: 'webgpu',
  backendReason: 'WebGPU adapter available',
};

describe('popupView', () => {
  it('offers to start on a video with nothing running', () => {
    const view = popupView({ report: null, url: YOUTUBE, key: 0 });

    expect(view.state).toBe('idle');
    expect(view.headline).toBe('Not running');
    expect(view.action).toBe('start');
    expect(view.actionLabel).toBe('Start');
    expect(view.progress).toBeNull();
  });

  it('says the panel is for YouTube when the tab is somewhere else', () => {
    const view = popupView({ report: null, url: 'https://example.com/', key: 0 });

    expect(view.detail).toBe('the on-page panel only works on YouTube');
    // Starting is still allowed: the stream may exist for a tab that is about
    // to navigate, and refusing here would be guessing.
    expect(view.action).toBe('start');
  });

  it('works on the local debug page too', () => {
    expect(pageNote('http://localhost:5173/test/page.html')).toBeNull();
  });

  it('shows the bar while it gets ready and offers to stop', () => {
    const view = popupView({
      report: report({
        status: 'preparing',
        prepare: { stage: 'separating', fraction: 0.62, pieces: null, aboutSeconds: 20 },
      }),
      url: YOUTUBE,
      key: 0,
    });

    expect(view.state).toBe('preparing');
    expect(view.headline).toBe('Getting ready');
    expect(view.progress).toBeCloseTo(0.62);
    expect(view.detail).toBe('Taking the vocal out · about 20 s left');
    expect(view.action).toBe('stop');
  });

  it('says which way the vocal switch is sitting once ready', () => {
    const on = popupView({ report: report({ status: 'ready', mode: 'original' }), url: YOUTUBE, key: 0 });
    const off = popupView({
      report: report({ status: 'ready', mode: 'instrumental' }),
      url: YOUTUBE,
      key: 0,
    });

    expect(on.detail).toContain('vocals on');
    expect(off.detail).toContain('vocals muted');
  });

  it('says how much vocal is in the mix', () => {
    const some = popupView({
      report: report({
        status: 'ready',
        mode: 'instrumental',
        mix: withMute(withStem(DEFAULT_MIX, 'vocals', 0.4), 'vocals', false),
      }),
      url: YOUTUBE,
      key: 0,
    });
    const full = popupView({
      report: report({
        status: 'ready',
        mode: 'instrumental',
        mix: withMute(withStem(DEFAULT_MIX, 'vocals', 1), 'vocals', false),
      }),
      url: YOUTUBE,
      key: 0,
    });

    expect(some.detail).toContain('vocals at 40%');
    expect(full.detail).toContain('vocals full');
  });

  it('explains a mute or a solo that outranks the vocal slider', () => {
    const muted = popupView({
      report: report({
        status: 'ready',
        mode: 'instrumental',
        mix: withMute(withStem(DEFAULT_MIX, 'vocals', 0.4), 'vocals', true),
      }),
      url: YOUTUBE,
      key: 0,
    });
    const backingSolo = popupView({
      report: report({
        status: 'ready',
        mode: 'instrumental',
        mix: withSolo(
          withMute(withStem(DEFAULT_MIX, 'vocals', 0.4), 'vocals', false),
          'drums',
          true,
        ),
      }),
      url: YOUTUBE,
      key: 0,
    });
    const vocalSolo = popupView({
      report: report({
        status: 'ready',
        mode: 'instrumental',
        mix: withSolo(
          withMute(withStem(DEFAULT_MIX, 'vocals', 0.4), 'vocals', false),
          'vocals',
          true,
        ),
      }),
      url: YOUTUBE,
      key: 0,
    });

    expect(muted.detail).toContain('vocals muted');
    expect(backingSolo.detail).toContain('another stem is soloed');
    expect(vocalSolo.detail).toContain('vocals soloed at 40%');
  });

  it('prefers the key of the running session over the remembered default', () => {
    const view = popupView({
      report: report({ status: 'ready', semitones: -3 }),
      url: YOUTUBE,
      key: 5,
    });

    expect(view.semitones).toBe(-3);
    expect(view.keyLabel).toBe('Key −3');
  });

  it('shows the remembered default with nothing running', () => {
    const view = popupView({ report: null, url: YOUTUBE, key: 2 });

    expect(view.semitones).toBe(2);
    expect(view.keyLabel).toBe('Key +2');
  });

  it('reports a dead end with its reason and offers to stop', () => {
    const view = popupView({
      report: report({ status: 'unsupported', reason: 'this machine has no WebGPU' }),
      url: YOUTUBE,
      key: 0,
    });

    expect(view.state).toBe('unsupported');
    expect(view.detail).toBe('this machine has no WebGPU');
    expect(view.action).toBe('stop');
  });

  it('does not leave an error with no words', () => {
    const view = popupView({ report: report({ status: 'error', reason: null }), url: YOUTUBE, key: 0 });

    expect(view.headline).toBe('It went wrong');
    // No engine words to show, but the next step is never missing.
    expect(view.detail).toBeNull();
    expect(view.advice).toContain('Try again');
  });

  it('translates the engine words the same way the panel does', () => {
    const view = popupView({
      report: report({ status: 'error', reason: 'the audio ended early (12 of 99 bytes)' }),
      url: YOUTUBE,
      key: 0,
    });

    expect(view.detail).toBe('The video stopped sending sound before the end. Press play, then try again.');
    expect(view.advice).toContain('Try again');
  });

  it('gives a dead end its next step too', () => {
    const view = popupView({
      report: report({ status: 'unsupported', reason: 'this machine has no WebGPU' }),
      url: YOUTUBE,
      key: 0,
    });

    expect(view.headline).toBe('Kara cannot run on this machine');
    expect(view.detail).toBe('this machine has no WebGPU');
    expect(view.advice).toContain('WebGPU');
  });

  it('says nothing about advice where there is nothing to do', () => {
    for (const status of ['idle', 'preparing', 'paused', 'ready'] as const) {
      const view = popupView({
        report: status === 'idle' ? null : report({ status }),
        url: YOUTUBE,
        key: 0,
      });

      expect(view.advice).toBeNull();
    }
  });

  it('says nothing about a pause beyond its name', () => {
    const view = popupView({ report: report({ status: 'paused' }), url: YOUTUBE, key: 0 });

    expect(view.state).toBe('paused');
    expect(view.headline).toBe('Paused');
    expect(view.detail).toBeNull();
  });

  it('offers no diagnostics when there is no session to describe', () => {
    expect(popupView({ report: null, url: YOUTUBE, key: 0 }).diagnostics).toBeNull();
  });

  it('groups the raw session and pipeline for the diagnostics disclosure', () => {
    const view = popupView({
      report: report({
        status: 'preparing',
        covered: true,
        prepare: { stage: 'separating', fraction: 0.62, pieces: null, aboutSeconds: 20 },
      }),
      url: YOUTUBE,
      key: 0,
      pipeline: PIPELINE,
    });
    const groups = view.diagnostics?.groups ?? [];
    const rows = groups.flatMap((group) => group.rows);

    expect(groups.map((group) => group.title)).toEqual(['Session', 'Analysis', 'Audio']);
    expect(rows).toContainEqual({ label: 'Stage', value: 'separating' });
    expect(rows).toContainEqual({ label: 'Progress', value: '62%' });
    expect(rows).toContainEqual({ label: 'Covered', value: 'yes' });
    expect(rows).toContainEqual({ label: 'Backend', value: 'webgpu' });
    expect(rows).toContainEqual({ label: 'Windows', value: '3 / 9' });
    expect(rows).toContainEqual({ label: 'Compute', value: '1250 ms' });
    expect(rows).toContainEqual({ label: 'Download', value: '3.2 MB / 5.0 MB' });
    expect(rows).toContainEqual({ label: 'Stems', value: '45.2 s' });
    expect(rows).toContainEqual({
      label: 'Why',
      value: 'WebGPU adapter available',
      wide: true,
    });
  });
});
