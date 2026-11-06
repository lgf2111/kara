import { describe, expect, it } from 'vitest';

import {
  normalisePracticeScore,
  type PracticeAnalysis,
  type PracticeLive,
  type PracticeNote,
} from '../src/audio/practice.ts';
import {
  PRACTICE_PLAYHEAD,
  practiceOverlayView,
  practiceTone,
} from '../src/content/practice-view.ts';

const notes: PracticeNote[] = [
  { start: 0, end: 1, midi: 60, confidence: 0.9 },
  { start: 1.5, end: 2.5, midi: 64, confidence: 0.9 },
  { start: 9, end: 10, midi: 67, confidence: 0.9 },
];

const listening: PracticeAnalysis = {
  state: 'ready',
  progress: 1,
  notes,
  detail: null,
};

function live(patch: Partial<PracticeLive> = {}): PracticeLive {
  return {
    listening: true,
    atSeconds: 0.5,
    mic: { hz: 261.63, midi: 60, level: 0.2, clarity: 0.9 },
    target: { index: 0, midi: 60, start: 0, end: 1 },
    cents: 0,
    score: normalisePracticeScore({ score: 80, notesHit: 1, notesTotal: 3, combo: 2 }),
    ...patch,
  };
}

describe('practiceOverlayView', () => {
  it('is hidden with no analysis and no summary', () => {
    const view = practiceOverlayView({ analysis: null, live: null, at: 3 });

    expect(view.mode).toBe('hidden');
    expect(view.notes).toEqual([]);
    expect(view.marker).toBeNull();
  });

  it('shows the learning pass and its progress', () => {
    const view = practiceOverlayView({
      analysis: {
        state: 'analyzing',
        progress: 0.36,
        notes: null,
        detail: 'Learning the guide melody.',
      },
      live: null,
      at: 0,
    });

    expect(view.mode).toBe('learning');
    expect(view.learning?.progress).toBeCloseTo(0.36);
    expect(view.learning?.detail).toContain('Learning');
    expect(view.marker).toBeNull();
  });

  it('draws the notes around the playhead and highlights the target', () => {
    const view = practiceOverlayView({ analysis: listening, live: live(), at: 0.5 });
    const first = view.notes.find((note) => note.index === 0);
    const second = view.notes.find((note) => note.index === 1);
    const later = view.notes.find((note) => note.index === 2);

    expect(view.mode).toBe('listening');
    expect(view.playhead).toBe(PRACTICE_PLAYHEAD);
    expect(first?.current).toBe(true);
    expect(first?.name).toBe('C4');
    expect(first?.left).toBeGreaterThan(0);
    expect(first?.left).toBeLessThan(PRACTICE_PLAYHEAD);
    expect(second?.current).toBe(false);
    // Nine seconds is outside the eight-second window at this playhead.
    expect(later).toBeUndefined();
    expect(view.currentName).toBe('C4');
  });

  it('moves the lane with the video clock', () => {
    const early = practiceOverlayView({ analysis: listening, live: live(), at: 0.5 });
    const late = practiceOverlayView({ analysis: listening, live: live(), at: 1.8 });
    const first = early.notes.find((note) => note.index === 0);
    const shifted = late.notes.find((note) => note.index === 0);

    expect(first?.left).toBeDefined();
    expect(shifted?.left).toBeDefined();
    expect(shifted?.left).toBeLessThan(first?.left ?? 0);
    expect(shifted?.past).toBe(true);
  });

  it('colours the marker by the cents error', () => {
    expect(practiceTone(0)).toBe('perfect');
    expect(practiceTone(-50)).toBe('perfect');
    expect(practiceTone(51)).toBe('good');
    expect(practiceTone(-100)).toBe('good');
    expect(practiceTone(101)).toBe('off');
    expect(practiceTone(null)).toBe('idle');

    expect(
      practiceOverlayView({ analysis: listening, live: live({ cents: 80 }), at: 0.5 }).marker?.tone,
    ).toBe('good');
    expect(
      practiceOverlayView({ analysis: listening, live: live({ cents: 200 }), at: 0.5 }).marker
        ?.tone,
    ).toBe('off');
  });

  it('puts the marker at the playhead and the singer’s pitch', () => {
    const low = practiceOverlayView({
      analysis: listening,
      live: live({ mic: { hz: 261.63, midi: 60, level: 0.2, clarity: 0.9 } }),
      at: 0.5,
    });
    const high = practiceOverlayView({
      analysis: listening,
      live: live({ mic: { hz: 523.25, midi: 72, level: 0.2, clarity: 0.9 } }),
      at: 0.5,
    });

    expect(low.marker?.x).toBe(PRACTICE_PLAYHEAD);
    expect(high.marker?.y).toBeLessThan(low.marker?.y ?? 1);
  });

  it('shows the frozen summary after the video ends', () => {
    const summary = normalisePracticeScore({
      score: 73,
      accuracy: 82,
      notesHit: 6,
      notesTotal: 10,
      longestStreak: 4,
    });
    const view = practiceOverlayView({
      analysis: null,
      live: null,
      summary,
      at: 0,
    });

    expect(view.mode).toBe('ended');
    expect(view.summary?.score).toBe(73);
    expect(view.summary?.notesHit).toBe(6);
    expect(view.summary?.accuracy).toBe(82);
    expect(view.summary?.longestStreak).toBe(4);
    expect(view.notes).toEqual([]);
  });

  it('carries the microphone error and no lane', () => {
    const view = practiceOverlayView({
      analysis: {
        state: 'error',
        progress: null,
        notes: null,
        detail: 'Open the Kara popup and press Enable microphone once.',
      },
      live: null,
      at: 0,
    });

    expect(view.mode).toBe('error');
    expect(view.error).toContain('Enable microphone');
    expect(view.notes).toEqual([]);
  });

  it('is not listening while the video is paused', () => {
    const view = practiceOverlayView({
      analysis: listening,
      live: live({ listening: false }),
      at: 0.5,
    });

    expect(view.mode).toBe('listening');
    expect(view.listening).toBe(false);
  });
});
