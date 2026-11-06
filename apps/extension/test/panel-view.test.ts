import { describe, expect, it } from 'vitest';

import { DEFAULT_DUET_MIX, type DuetStatus } from '../src/audio/duet.ts';
import { DEFAULT_MIC_FX, normaliseMicStatus } from '../src/audio/mic-fx.ts';
import type { PracticeAnalysis } from '../src/audio/practice.ts';
import type { SongAnalysis } from '../src/audio/song-analysis.ts';
import { IDLE_RECORDING } from '../src/audio/recording.ts';
import { DEFAULT_MIX, withMute, withSolo, withStem } from '../src/audio/stems.ts';
import { panelView, prepareDetail } from '../src/content/panel-view.ts';
import { report, separating } from './report.ts';

describe('panelView', () => {
  it('offers to start when nothing is running', () => {
    const view = panelView({ report: null });

    expect(view.state).toBe('off');
    expect(view.label).toBe('Start karaoke');
    expect(view.controls).toBe(false);
    expect(view.progress).toBeNull();
  });

  it('shows a bar and the stage while it gets ready, and no controls', () => {
    const view = panelView({
      report: report({
        status: 'preparing',
        prepare: { stage: 'loading', fraction: 0.3, pieces: { loaded: 2, total: 21 }, aboutSeconds: null },
      }),
    });

    expect(view.state).toBe('preparing');
    expect(view.progress).toBeCloseTo(0.3);
    expect(view.detail).toBe('Loading the model, 2 of 21');
    expect(view.controls).toBe(false);
  });

  it('offers the controls while preparing once the stems reach the playhead', () => {
    const view = panelView({
      report: report({
        status: 'preparing',
        covered: true,
        prepare: separating(10, 40, 15),
      }),
    });

    expect(view.state).toBe('preparing');
    expect(view.label).toBe('Preparing karaoke');
    expect(view.controls).toBe(true);
    expect(view.note).toBe('the rest is still being prepared');
    expect(view.progress).toBeCloseTo(0.25);
  });

  it('shows the estimate where there is one, without pretending it is a countdown', () => {
    const view = panelView({
      report: report({
        status: 'preparing',
        prepare: separating(10, 40, 15),
      }),
    });

    expect(view.detail).toBe('Taking the vocal out · about 15 s left');
  });

  it('shows the toggle once the stems are ready', () => {
    const view = panelView({
      report: report({
        status: 'ready',
        mode: 'instrumental',
        mix: withStem(DEFAULT_MIX, 'vocals', 0.4),
        semitones: 2,
      }),
    });

    expect(view.state).toBe('ready');
    expect(view.label).toBe('Karaoke on');
    expect(view.controls).toBe(true);
    expect(view.mode).toBe('instrumental');
    expect(view.mix.levels.vocals).toBeCloseTo(0.4);
    expect(view.keyLabel).toContain('+2');
  });

  it('says nothing about a pause, and keeps the controls', () => {
    const view = panelView({ report: report({ status: 'paused' }) });

    expect(view.state).toBe('paused');
    expect(view.label).toBe('Paused');
    expect(view.detail).toBeNull();
    expect(view.note).toBeNull();
    expect(view.controls).toBe(true);
  });

  it('gives the reason for a dead end rather than a generic failure', () => {
    const view = panelView({
      report: report({ status: 'unsupported', reason: 'this machine has no WebGPU' }),
    });

    expect(view.state).toBe('unsupported');
    expect(view.label).toBe('Not available here');
    expect(view.detail).toBe('this machine has no WebGPU');
    expect(view.controls).toBe(false);
  });

  it('does not leave an error with no words', () => {
    const view = panelView({ report: report({ status: 'error', reason: null }) });

    expect(view.state).toBe('error');
    expect(view.detail).toBe('no reason given');
  });

  it('clamps a key and a mix that arrived out of range', () => {
    const view = panelView({
      report: report({
        status: 'ready',
        semitones: 99,
        mix: {
          ...DEFAULT_MIX,
          levels: { ...DEFAULT_MIX.levels, drums: -2, vocals: 4 },
        },
      }),
    });

    expect(view.semitones).toBe(6);
    expect(view.mix.levels.drums).toBe(0);
    expect(view.mix.levels.vocals).toBe(1);
  });

  it('keeps mute and solo switches beside the levels they do not move', () => {
    const mix = withSolo(withMute(withStem(DEFAULT_MIX, 'bass', 0.3), 'drums', true), 'bass', true);
    const view = panelView({ report: report({ status: 'ready', mix }) });

    expect(view.mix.levels.bass).toBeCloseTo(0.3);
    expect(view.mix.muted.drums).toBe(true);
    expect(view.mix.soloed.bass).toBe(true);
    expect(view.mix.soloed.drums).toBe(false);
  });
});

describe('prepareDetail', () => {
  it('is nothing at all when nothing is being prepared', () => {
    expect(prepareDetail(report())).toBeNull();
  });
});

describe('the microphone desk', () => {
  function mic(patch: Record<string, unknown> = {}): ReturnType<typeof normaliseMicStatus> {
    return normaliseMicStatus({
      fx: DEFAULT_MIC_FX,
      enabled: true,
      monitor: false,
      error: null,
      recording: IDLE_RECORDING,
      ...patch,
    });
  }

  it('starts with the monitor off and says why', () => {
    const view = panelView({ report: report({ status: 'ready' }) });

    expect(view.mic).toEqual(DEFAULT_MIC_FX);
    expect(view.micOn).toBe(false);
    expect(view.monitorOn).toBe(false);
    expect(view.micWarning).toContain('headphones');
    expect(view.recordLabel).toBe('Record');
    expect(view.recordTimer).toBe('0:00');
    expect(view.recordActive).toBe(false);
  });

  it('shows the monitor only once the engine says it is audible', () => {
    const view = panelView({
      report: report({
        status: 'ready',
        mic: mic({ fx: { ...DEFAULT_MIC_FX, monitor: true }, monitor: true }),
      }),
    });

    expect(view.micOn).toBe(true);
    expect(view.monitorOn).toBe(true);
  });

  it('counts a take and calls the button Stop', () => {
    const view = panelView({
      report: report({
        status: 'ready',
        mic: mic({
          recording: {
            state: 'recording',
            startedAtMs: 1,
            seconds: 65,
            filename: 'kara-x.webm',
            detail: null,
          },
        }),
      }),
    });

    expect(view.recordingState).toBe('recording');
    expect(view.recordActive).toBe(true);
    expect(view.recordLabel).toBe('Stop');
    expect(view.recordTimer).toBe('1:05');
  });

  it('names the saved file and keeps a failure in the panel', () => {
    const saved = panelView({
      report: report({
        status: 'ready',
        mic: mic({
          recording: {
            state: 'saved',
            startedAtMs: null,
            seconds: 12,
            filename: 'kara-x.webm',
            detail: null,
          },
        }),
      }),
    });
    const failed = panelView({
      report: report({
        status: 'ready',
        mic: mic({
          recording: {
            state: 'error',
            startedAtMs: null,
            seconds: 12,
            filename: 'kara-x.webm',
            detail: 'The recorder stopped.',
          },
        }),
      }),
    });

    expect(saved.recordLabel).toBe('Record again');
    expect(saved.micDetail).toContain('kara-x.webm');
    expect(saved.micError).toBe(false);
    expect(failed.micError).toBe(true);
    expect(failed.micDetail).toBe('The recorder stopped.');
  });
});

describe('pitch practice', () => {
  const learning: PracticeAnalysis = {
    state: 'analyzing',
    progress: 0.42,
    notes: null,
    detail: 'Learning the guide melody.',
  };
  const listening: PracticeAnalysis = {
    state: 'ready',
    progress: 1,
    notes: [{ start: 0, end: 1, midi: 69, confidence: 0.9 }],
    detail: null,
  };
  const failed: PracticeAnalysis = {
    state: 'error',
    progress: null,
    notes: null,
    detail: 'Open the Kara popup and press Enable microphone once.',
  };

  it('offers the entry point once the full vocal stem is ready', () => {
    const view = panelView({ report: report({ status: 'ready' }) });

    expect(view.practiceState).toBe('off');
    expect(view.practiceCanStart).toBe(true);
    expect(view.practiceActive).toBe(false);
    expect(view.practiceLabel).toBe('Practice');
    expect(view.practiceHint).toBeNull();
    expect(view.practiceTooltip).toBeNull();
  });

  it('keeps the entry point disabled while the stem is still arriving', () => {
    const view = panelView({ report: report({ status: 'preparing', covered: true }) });

    expect(view.controls).toBe(true);
    expect(view.practiceCanStart).toBe(false);
    expect(view.practiceState).toBe('off');
    expect(view.practiceHint).toBe('Waiting for the whole song to be analyzed.');
    expect(view.practiceTooltip).toBe(
      'Practice unlocks when the whole song has been analyzed.',
    );
  });

  it('shows the learning pass with its bar and no way to start twice', () => {
    const view = panelView({ report: report({ status: 'ready' }), practice: learning });

    expect(view.practiceState).toBe('analyzing');
    expect(view.practiceActive).toBe(true);
    expect(view.practiceProgress).toBeCloseTo(0.42);
    expect(view.practiceDetail).toContain('Learning');
    expect(view.practiceCanStart).toBe(false);
    expect(view.practiceHint).toBeNull();
    expect(view.practiceTooltip).toBeNull();
  });

  it('says headphones once the microphone is listening', () => {
    const view = panelView({ report: report({ status: 'ready' }), practice: listening });

    expect(view.practiceState).toBe('ready');
    expect(view.practiceLabel).toBe('Practice on');
    expect(view.practiceDetail).toContain('headphones');
    expect(view.practiceActive).toBe(true);
    expect(view.practiceCanStart).toBe(false);
    expect(view.practiceHint).toBeNull();
    expect(view.practiceTooltip).toBeNull();
  });

  it('keeps a microphone refusal in the panel where it can be read', () => {
    const view = panelView({ report: report({ status: 'ready' }), practice: failed });

    expect(view.practiceState).toBe('error');
    expect(view.practiceDetail).toContain('Enable microphone');
    expect(view.practiceActive).toBe(false);
    expect(view.practiceCanStart).toBe(true);
    expect(view.practiceHint).toBeNull();
    expect(view.practiceTooltip).toBeNull();
  });
});

describe('the song card', () => {
  const ready: SongAnalysis = {
    state: 'ready',
    progress: 1,
    facts: {
      key: { tonic: 7, mode: 'major', confidence: 0.8 },
      bpm: 128.4,
      bpmConfidence: 0.7,
      range: { lowMidi: 48, highMidi: 76, confidence: 0.6, frames: 120 },
    },
    detail: null,
  };
  const unsure: SongAnalysis = {
    state: 'ready',
    progress: 1,
    facts: {
      key: null,
      bpm: null,
      bpmConfidence: 0.1,
      range: null,
    },
    detail: null,
  };

  it('has nothing to say before an analysis exists', () => {
    const view = panelView({ report: report({ status: 'ready' }) });

    expect(view.songAnalysisState).toBe('off');
    expect(view.songKey).toBeNull();
    expect(view.songBpm).toBeNull();
  });

  it('shows the key, tempo and range when it is ready', () => {
    const view = panelView({ report: report({ status: 'ready' }), analysis: ready });

    expect(view.songAnalysisState).toBe('ready');
    expect(view.songKey).toBe('G major');
    expect(view.songBpm).toBe(128);
    expect(view.songRange).toBe('C3–E5');
    expect(view.songDetail).toBeNull();
  });

  it('asks rather than guessing when the key and tempo are unsure', () => {
    const view = panelView({ report: report({ status: 'ready' }), analysis: unsure });

    expect(view.songAnalysisState).toBe('ready');
    expect(view.songKey).toBeNull();
    expect(view.songBpm).toBeNull();
    expect(view.songRange).toBeNull();
  });

  it('shows the line while the analysis runs', () => {
    const view = panelView({
      report: report({ status: 'ready' }),
      analysis: {
        state: 'analyzing',
        progress: 0.3,
        facts: null,
        detail: 'Reading the song.',
      },
    });

    expect(view.songAnalysisState).toBe('analyzing');
    expect(view.songDetail).toBe('Reading the song.');
  });
});

describe('the duet desk', () => {
  const preparing: DuetStatus = {
    state: 'preparing',
    progress: { phase: 'separating', done: 5, total: 20 },
    detail: null,
    mix: DEFAULT_DUET_MIX,
    hasVoices: false,
    lowConfidenceSeconds: null,
  };
  const calibrating: DuetStatus = {
    state: 'preparing',
    progress: { phase: 'calibrating', done: 0, total: 0 },
    detail: null,
    mix: DEFAULT_DUET_MIX,
    hasVoices: true,
    lowConfidenceSeconds: 20,
  };
  const ready: DuetStatus = {
    state: 'ready',
    progress: null,
    detail: null,
    mix: DEFAULT_DUET_MIX,
    hasVoices: true,
    lowConfidenceSeconds: 20,
  };
  const failed: DuetStatus = {
    state: 'error',
    progress: null,
    detail: 'Paste the Duet helper token in the Kara popup.',
    mix: DEFAULT_DUET_MIX,
    hasVoices: false,
    lowConfidenceSeconds: null,
  };

  it('is off and offers the button when karaoke is ready', () => {
    const view = panelView({ report: report({ status: 'ready' }) });

    expect(view.duetState).toBe('off');
    expect(view.duetCanStart).toBe(true);
    expect(view.duetProgress).toBeNull();
  });

  it('shows the second bar while the helper runs, without taking the vocal row', () => {
    const view = panelView({ report: report({ status: 'ready', duet: preparing }) });

    expect(view.duetState).toBe('preparing');
    expect(view.duetLabel).toBe('Splitting the two voices');
    expect(view.duetProgress).toBeCloseTo(0.25);
    expect(view.duetDetail).toBe('The normal vocal controls still work while this runs.');
    expect(view.controls).toBe(true);
  });

  it('cannot start before the first pass has finished', () => {
    const view = panelView({
      report: report({ status: 'preparing', covered: true, duet: preparing }),
    });

    expect(view.duetCanStart).toBe(false);
  });

  it('keeps the current pair on screen while it learns a new line', () => {
    const view = panelView({ report: report({ status: 'ready', duet: calibrating }) });

    expect(view.duetState).toBe('preparing');
    expect(view.duetHasVoices).toBe(true);
    expect(view.duetDetail).toBe('The current pair keeps playing while it re-renders.');
  });

  it('shows two voices and warns when the map was unsure', () => {
    const view = panelView({ report: report({ status: 'ready', duet: ready }) });

    expect(view.duetState).toBe('ready');
    expect(view.duetLabel).toBe('Duet ready');
    expect(view.duetDetail).toContain('uncertain');
    expect(view.duetMix.muted).toEqual([false, false]);
  });

  it('keeps karaoke alive when the helper is missing', () => {
    const view = panelView({ report: report({ status: 'ready', duet: failed }) });

    expect(view.duetState).toBe('error');
    expect(view.duetLabel).toBe('Duet stopped');
    expect(view.duetDetail).toContain('token');
    expect(view.duetCanStart).toBe(true);
  });
});
