import { describe, expect, it } from 'vitest';

import {
  normalisePracticeScore,
  type PracticeAnalysis,
  type PracticeLive,
  type PracticeNote,
} from '../src/audio/practice.ts';
import {
  PRACTICE_PLAYHEAD,
  PRACTICE_WINDOW_SECONDS,
  practiceOverlayView,
  practicePitchRange,
  practiceTone,
  type PracticeLaneNote,
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

function guideNote(
  view: ReturnType<typeof practiceOverlayView>,
  index: number,
): PracticeLaneNote | undefined {
  return view.notes.find((note) => note.index === index);
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
    const first = guideNote(view, 0);
    const second = guideNote(view, 1);
    const later = guideNote(view, 2);

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

  it('moves the note rectangles with the video clock', () => {
    const early = practiceOverlayView({ analysis: listening, live: live(), at: 0.5 });
    const late = practiceOverlayView({ analysis: listening, live: live(), at: 1.8 });
    const first = guideNote(early, 0);
    const shifted = guideNote(late, 0);

    expect(first?.left).toBeDefined();
    expect(shifted?.left).toBeDefined();
    // One-and-a-third seconds is exactly a sixth of the eight-second field.
    expect((first?.left ?? 0) - (shifted?.left ?? 0)).toBeCloseTo(1.3 / PRACTICE_WINDOW_SECONDS);
    expect(shifted?.width).toBeCloseTo(first?.width ?? 0);
    expect(shifted?.past).toBe(true);
    expect(shifted?.current).toBe(false);
  });

  it('clips a note to the field rather than letting it draw past the edge', () => {
    const clipped: PracticeAnalysis = {
      state: 'ready',
      progress: 1,
      notes: [{ start: 4, end: 7, midi: 60, confidence: 0.9 }],
      detail: null,
    };
    const atStart = practiceOverlayView({ analysis: clipped, live: null, at: 7 });
    const atEnd = practiceOverlayView({ analysis: clipped, live: null, at: 1 });

    expect(guideNote(atStart, 0)?.left).toBe(0);
    expect(guideNote(atStart, 0)?.width).toBeCloseTo(PRACTICE_PLAYHEAD);
    expect(guideNote(atEnd, 0)?.left).toBeCloseTo(
      (4 - (1 - PRACTICE_WINDOW_SECONDS * PRACTICE_PLAYHEAD)) / PRACTICE_WINDOW_SECONDS,
    );
    expect(guideNote(atEnd, 0)?.width).toBeCloseTo(
      (1 +
        PRACTICE_WINDOW_SECONDS * (1 - PRACTICE_PLAYHEAD) -
        4) /
        PRACTICE_WINDOW_SECONDS,
    );
  });

  it('holds the picture still while playback is paused', () => {
    const paused = practiceOverlayView({
      analysis: listening,
      live: live({ listening: false }),
      at: 1.8,
    });
    const still = practiceOverlayView({
      analysis: listening,
      live: live({ listening: false }),
      at: 1.8,
    });

    expect(still).toEqual(paused);
    expect(still.notes.map((note) => note.left)).toEqual(paused.notes.map((note) => note.left));
  });

  it('maps a seek straight to the same picture as playing there', () => {
    const seeked = practiceOverlayView({ analysis: listening, live: live(), at: 9 });
    const played = practiceOverlayView({ analysis: listening, live: live(), at: 0.5 });
    const back = practiceOverlayView({ analysis: listening, live: live(), at: 0.5 });

    expect(guideNote(seeked, 2)?.current).toBe(true);
    expect(guideNote(seeked, 2)?.left).toBeCloseTo(PRACTICE_PLAYHEAD);
    expect(guideNote(seeked, 0)).toBeUndefined();
    expect(guideNote(seeked, 1)).toBeUndefined();
    expect(back).toEqual(played);
  });

  it('dims past notes and lets the live guide pick the current one', () => {
    const view = practiceOverlayView({ analysis: listening, live: live(), at: 2.2 });
    const first = guideNote(view, 0);
    const second = guideNote(view, 1);

    expect(first?.past).toBe(true);
    expect(first?.current).toBe(false);
    expect(second?.current).toBe(true);
    expect(second?.past).toBe(false);
    expect(view.currentName).toBe('E4');
  });

  it('stops highlighting once a note is gone and the field reaches a rest', () => {
    const view = practiceOverlayView({
      analysis: listening,
      live: live({ target: null, cents: null }),
      at: 3,
    });
    const second = guideNote(view, 1);

    expect(second?.past).toBe(true);
    expect(second?.current).toBe(false);
    expect(view.currentName).toBeNull();
  });

  it('keeps the pitch span wide enough for the visible notes and the singer', () => {
    const idle = practicePitchRange([], 60);
    const wide = practicePitchRange(
      [
        { start: 0, end: 1, midi: 48, confidence: 0.9 },
        { start: 1, end: 2, midi: 72, confidence: 0.9 },
      ],
      null,
    );
    const near = practicePitchRange(
      [
        { start: 0, end: 1, midi: 60, confidence: 0.9 },
        { start: 1, end: 2, midi: 67, confidence: 0.9 },
      ],
      74,
    );
    const far = practicePitchRange(
      [
        { start: 0, end: 1, midi: 60, confidence: 0.9 },
        { start: 1, end: 2, midi: 67, confidence: 0.9 },
      ],
      100,
    );

    expect(idle.high - idle.low).toBeGreaterThanOrEqual(12);
    expect(wide.low).toBeLessThanOrEqual(48);
    expect(wide.high).toBeGreaterThanOrEqual(72);
    expect(near.low).toBeLessThanOrEqual(60);
    expect(near.high).toBeGreaterThanOrEqual(74);
    expect(far).toEqual({ low: 57.5, high: 69.5 });
  });

  it('keeps every rectangle inside the field and the marker on the singer’s pitch', () => {
    const wide: PracticeAnalysis = {
      state: 'ready',
      progress: 1,
      notes: [
        { start: 0, end: 1, midi: 48, confidence: 0.9 },
        { start: 1, end: 2, midi: 72, confidence: 0.9 },
      ],
      detail: null,
    };
    const view = practiceOverlayView({
      analysis: wide,
      live: live({
        mic: { hz: 523.25, midi: 72, level: 0.2, clarity: 0.9 },
        target: { index: 1, midi: 72, start: 1, end: 2 },
      }),
      at: 1.5,
    });
    const low = guideNote(view, 0);
    const high = guideNote(view, 1);

    for (const note of view.notes) {
      expect(note.top).toBeGreaterThanOrEqual(0);
      expect(note.top + note.height).toBeLessThanOrEqual(1);
      expect(note.height).toBeGreaterThan(0);
    }
    expect(view.marker?.x).toBe(PRACTICE_PLAYHEAD);
    expect(view.marker?.y).toBeCloseTo((high?.top ?? 0) + (high?.height ?? 0) / 2);
    expect(view.marker?.y).toBeLessThan((low?.top ?? 0) + (low?.height ?? 0) / 2);
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
    expect(low.marker?.y).toBeCloseTo(
      (guideNote(low, 0)?.top ?? 0) + (guideNote(low, 0)?.height ?? 0) / 2,
    );
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

  it('carries the microphone error and no field', () => {
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
