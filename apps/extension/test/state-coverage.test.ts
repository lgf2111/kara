import { describe, expect, it } from 'vitest';

import { IDLE_DUET, type DuetStatus } from '../src/audio/duet.ts';
import { IDLE_MIC_STATUS, normaliseMicStatus } from '../src/audio/mic-fx.ts';
import type { PracticeAnalysis } from '../src/audio/practice.ts';
import type { SongAnalysis } from '../src/audio/song-analysis.ts';
import { panelView } from '../src/content/panel-view.ts';
import { popupView } from '../src/popup/popup-view.ts';
import type { StatusReport } from '../src/protocol.ts';
import { report } from './report.ts';

/**
 * The coverage grid.
 *
 * Every state either surface can be in, enumerated here rather than described
 * in a document. The point is not to re-test the copy, which the view tests do;
 * it is to make "every state is designed" a failing build when someone adds a
 * state and forgets it, and to prove the pair of surfaces never disagree about
 * the same report.
 *
 * A table entry is the smallest input that reaches the state; if a state is not
 * in the table, no test in the repository reaches it, and that is the finding.
 */

interface PanelCase {
  readonly name: string;
  readonly report: StatusReport | null;
  readonly practice?: PracticeAnalysis;
  readonly analysis?: SongAnalysis;
  readonly expect: {
    readonly state: string;
    readonly actionLabel: string;
    readonly hasControls: boolean;
    readonly advice: 'always' | 'never';
  };
}

const READY = (): StatusReport => report({ status: 'ready' });

const PANEL_CASES: readonly PanelCase[] = [
  {
    name: 'off',
    report: null,
    expect: { state: 'off', actionLabel: 'Start karaoke', hasControls: false, advice: 'never' },
  },
  {
    name: 'preparing, before the playhead is covered',
    report: report({
      status: 'preparing',
      prepare: { stage: 'download', fraction: 0.1, pieces: null, aboutSeconds: 30 },
    }),
    expect: { state: 'preparing', actionLabel: 'Preparing karaoke', hasControls: false, advice: 'never' },
  },
  {
    name: 'preparing, covered',
    report: report({
      status: 'preparing',
      covered: true,
      prepare: { stage: 'separating', fraction: 0.4, pieces: null, aboutSeconds: 12 },
    }),
    expect: { state: 'preparing', actionLabel: 'Preparing karaoke', hasControls: true, advice: 'never' },
  },
  {
    name: 'ready',
    report: READY(),
    expect: { state: 'ready', actionLabel: 'Karaoke on', hasControls: true, advice: 'never' },
  },
  {
    name: 'paused',
    report: report({ status: 'paused' }),
    expect: { state: 'paused', actionLabel: 'Paused', hasControls: true, advice: 'never' },
  },
  {
    name: 'unsupported',
    report: report({ status: 'unsupported', reason: 'no WebGPU adapter' }),
    expect: {
      state: 'unsupported',
      actionLabel: "Kara can't run on this machine",
      hasControls: false,
      advice: 'always',
    },
  },
  {
    name: 'error with a known reason',
    report: report({ status: 'error', reason: 'the audio ended early (1 of 2 bytes)' }),
    expect: { state: 'error', actionLabel: 'Karaoke stopped', hasControls: false, advice: 'always' },
  },
  {
    name: 'error with no reason',
    report: report({ status: 'error', reason: null }),
    expect: { state: 'error', actionLabel: 'Karaoke stopped', hasControls: false, advice: 'always' },
  },
];

const DUET_STATES = ['off', 'preparing', 'ready', 'error'] as const;
const PRACTICE_STATES = ['off', 'analyzing', 'ready', 'error'] as const;
const SONG_STATES = ['off', 'analyzing', 'ready', 'error'] as const;
const RECORDING_STATES = ['idle', 'recording', 'saving', 'saved', 'error'] as const;

describe('state coverage', () => {
  it('reaches every panel state the view can report', () => {
    for (const entry of PANEL_CASES) {
      const view = panelView({ report: entry.report });

      expect(view.state, entry.name).toBe(entry.expect.state);
      expect(view.label, entry.name).toBe(entry.expect.actionLabel);
      expect(view.controls, entry.name).toBe(entry.expect.hasControls);
      if (entry.expect.advice === 'always') {
        expect(view.advice, entry.name).not.toBeNull();
      } else {
        expect(view.advice, entry.name).toBeNull();
      }
    }
    // The states above are exactly the union the type allows.
    expect(new Set(PANEL_CASES.map((entry) => entry.expect.state))).toEqual(
      new Set(['off', 'preparing', 'ready', 'paused', 'unsupported', 'error']),
    );
  });

  it('reaches every popup state the view can report', () => {
    const cases: readonly [string, StatusReport | null, string][] = [
      ['idle', null, 'idle'],
      ['preparing', report({ status: 'preparing' }), 'preparing'],
      ['paused', report({ status: 'paused' }), 'paused'],
      ['ready', READY(), 'ready'],
      ['unsupported', report({ status: 'unsupported', reason: 'no WebGPU' }), 'unsupported'],
      ['error', report({ status: 'error', reason: 'the audio ended early' }), 'error'],
    ];

    for (const [name, input, expected] of cases) {
      const view = popupView({ report: input, url: 'https://www.youtube.com/watch?v=x', key: 0 });

      expect(view.state, name).toBe(expected);
    }
    expect(new Set(cases.map(([, , expected]) => expected))).toEqual(
      new Set(['idle', 'preparing', 'paused', 'ready', 'unsupported', 'error']),
    );
  });

  it('has a designed line for every duet state', () => {
    for (const state of DUET_STATES) {
      const duet: DuetStatus = { ...IDLE_DUET, state };
      const view = panelView({ report: report({ status: 'ready', duet }) });

      expect(view.duetLabel.trim(), state).not.toBe('');
    }
  });

  it('has a designed line for every practice state', () => {
    for (const state of PRACTICE_STATES) {
      const practice = { state, progress: state === 'analyzing' ? 0.5 : null, detail: null } as PracticeAnalysis;
      const view = panelView({ report: READY(), practice });

      expect(view.practiceLabel.trim(), state).not.toBe('');
    }
  });

  it('has a designed line for every song-analysis state', () => {
    for (const state of SONG_STATES) {
      const analysis = { state, facts: null, detail: null } as SongAnalysis;
      const view = panelView({ report: READY(), analysis });

      expect(view.songAnalysisState, state).toBe(state);
      if (state !== 'ready') {
        // Not-ready states must either say something or say nothing on purpose.
        expect(view.songDetail === null || view.songDetail.trim() !== '', state).toBe(true);
      }
    }
  });

  it('has a designed label for every recording state', () => {
    for (const state of RECORDING_STATES) {
      const mic = normaliseMicStatus({ ...IDLE_MIC_STATUS, recording: { ...IDLE_MIC_STATUS.recording, state } });
      const view = panelView({ report: report({ status: 'ready', mic }) });

      expect(view.recordLabel.trim(), state).not.toBe('');
    }
  });

  it('never gives the two surfaces contradictory headlines for one report', () => {
    for (const entry of PANEL_CASES) {
      if (entry.report === null) {
        continue;
      }
      const panel = panelView({ report: entry.report });
      const popup = popupView({
        report: entry.report,
        url: 'https://www.youtube.com/watch?v=x',
        key: 0,
      });

      // Both must offer a way forward in exactly the same states.
      expect(popup.advice === null, entry.name).toBe(panel.advice === null);
      // And neither may claim a run is happening while the other says it stopped.
      expect(popup.action === 'stop', entry.name).toBe(
        entry.report.status !== 'idle',
      );
    }
  });
});
