import { describe, expect, it } from 'vitest';

import { midiToHz, type PitchFrame } from '../src/audio/pitch.ts';
import {
  analyseMelody,
  normalisePracticeAnalysis,
  normalisePracticeLive,
  normalisePracticeNotes,
  normalisePracticeScore,
  newPracticeScore,
  practiceScore,
  scorePracticeFrame,
  segmentNotes,
  targetAt,
  type PracticeNote,
} from '../src/audio/practice.ts';

const STEP = 0.032;

function frames(
  midi: number,
  count: number,
  start = 0,
  options: {
    readonly clarity?: number;
    readonly step?: number;
    readonly detune?: number;
    readonly level?: number;
  } = {},
): PitchFrame[] {
  const clarity = options.clarity ?? 0.9;
  const step = options.step ?? STEP;
  const detune = options.detune ?? 0;
  const level = options.level ?? 0.1;
  const made: PitchFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = midi + detune * (index % 2 === 0 ? 1 : -1);
    made.push({
      at: start + index * step,
      hz: midiToHz(value),
      midi: value,
      clarity,
      level,
    });
  }
  return made;
}

function partials(
  parts: readonly (readonly [number, number])[],
  seconds: number,
  sampleRate = 16_000,
): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (const [hz, amplitude] of parts) {
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] =
        (samples[index] ?? 0) + amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate);
    }
  }
  return samples;
}

function vibrato(hz: number, seconds: number, depthCents = 30, sampleRate = 16_000): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  let phase = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const at = index / sampleRate;
    const cents = depthCents * Math.sin(2 * Math.PI * 5 * at);
    phase += (2 * Math.PI * hz * 2 ** (cents / 1200)) / sampleRate;
    samples[index] = 0.35 * Math.sin(phase) + 0.1 * Math.sin(2 * phase);
  }
  return samples;
}

function noise(seconds: number, amplitude = 0.08, sampleRate = 16_000): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  let seed = 0x51f15e;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    samples[index] = ((seed / 0xffffffff) * 2 - 1) * amplitude;
  }
  return samples;
}

const melody: PracticeNote[] = [
  { start: 1, end: 1.5, midi: 69, confidence: 0.9 },
  { start: 1.5, end: 2, midi: 72, confidence: 0.9 },
];

function scoreFrames(notes: readonly PracticeNote[], midi: number | null, at: number, count = 20): ReturnType<typeof newPracticeScore> {
  let state = newPracticeScore(notes);
  for (let index = 0; index < count; index += 1) {
    state = scorePracticeFrame(
      state,
      { at: at + index * 0.05, midi },
      { frameSeconds: 0.05 },
    );
  }
  return state;
}

describe('segmentNotes', () => {
  it('turns a short melody into two notes', () => {
    const notes = segmentNotes([...frames(69, 16), ...frames(72, 16, 16 * STEP)]);

    expect(notes).toHaveLength(2);
    expect(notes[0]?.midi).toBe(69);
    expect(notes[1]?.midi).toBe(72);
    expect(notes[0]?.start).toBeCloseTo(0);
    expect(notes[0]?.end).toBeCloseTo(16 * STEP, 2);
  });

  it('keeps vibrato on one note', () => {
    const notes = segmentNotes(frames(69, 32, 0, { detune: 0.35 }));

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(69);
  });

  it('bridges a short same-pitch gap', () => {
    const notes = segmentNotes([
      ...frames(69, 8),
      ...frames(69, 8, 10 * STEP),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.end).toBeCloseTo(18 * STEP, 2);
  });

  it('drops a note too short to be sung', () => {
    const notes = segmentNotes([
      ...frames(69, 2),
      ...frames(72, 16, 2 * STEP),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(72);
  });

  it('drops frames below the clarity threshold', () => {
    const notes = segmentNotes(frames(69, 20, 0, { clarity: 0.2 }));

    expect(notes).toEqual([]);
  });

  it('drops an isolated octave spike and keeps the phrase legato', () => {
    const notes = segmentNotes([
      ...frames(69, 20),
      ...frames(81, 4, 20 * STEP),
      ...frames(69, 20, 24 * STEP),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(69);
    expect(notes[0]?.end).toBeCloseTo(44 * STEP, 2);
  });

  it('drops a short high note with no neighbour at its pitch', () => {
    const notes = segmentNotes([
      ...frames(60, 20),
      ...frames(84, 5, 20 * STEP),
      ...frames(60, 20, 25 * STEP),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(60);
  });

  it('keeps a high note that is actually sustained', () => {
    const notes = segmentNotes([
      ...frames(60, 20),
      ...frames(84, 12, 20 * STEP),
      ...frames(60, 20, 32 * STEP),
    ]);

    expect(notes.map((note) => note.midi)).toEqual([60, 84, 60]);
  });

  it('keeps a rest as a gap instead of joining two phrases', () => {
    const notes = segmentNotes([
      ...frames(69, 20),
      ...frames(69, 20, 36 * STEP),
    ]);

    expect(notes).toHaveLength(2);
    expect(notes[1]?.start).toBeCloseTo(36 * STEP, 2);
  });

  it('ignores frames below the local energy floor', () => {
    const notes = segmentNotes([
      ...frames(69, 20),
      ...frames(72, 8, 20 * STEP, { level: 0.005 }),
      ...frames(69, 20, 28 * STEP),
    ]);

    expect(notes.map((note) => note.midi)).toEqual([69, 69]);
  });

  it('keeps only notes inside the measured vocal range', () => {
    const notes = segmentNotes(
      [...frames(60, 20), ...frames(69, 20, 20 * STEP), ...frames(84, 20, 40 * STEP)],
      { range: { lowMidi: 64, highMidi: 72 } },
    );

    expect(notes.map((note) => note.midi)).toEqual([69]);
  });

  it('has nothing to show for silence', () => {
    expect(segmentNotes([])).toEqual([]);
  });
});

describe('targetAt', () => {
  it('finds the note under the playhead', () => {
    expect(targetAt(melody, 1.2)?.note.midi).toBe(69);
    expect(targetAt(melody, 1.7)?.note.midi).toBe(72);
  });

  it('allows a singer a little ahead or behind', () => {
    expect(targetAt(melody, 0.9, 0.15)?.note.midi).toBe(69);
    expect(targetAt(melody, 1.4, 0.15)?.note.midi).toBe(69);
  });

  it('has no target in a rest', () => {
    expect(targetAt(melody, 2.5)).toBeNull();
  });
});

describe('scoring', () => {
  it('gives a perfect run a hundred', () => {
    const state = scoreFrames([melody[0] as PracticeNote], 69, 1);
    const score = practiceScore(state);

    expect(score.score).toBeCloseTo(100);
    expect(score.accuracy).toBeCloseTo(100);
    expect(score.notesHit).toBe(1);
    expect(score.notesTotal).toBe(1);
    expect(score.longestStreak).toBe(1);
  });

  it('gives a good run partial credit but full accuracy', () => {
    const state = scoreFrames([melody[0] as PracticeNote], 69.8, 1);
    const score = practiceScore(state);

    expect(score.score).toBeCloseTo(70);
    expect(score.accuracy).toBeCloseTo(100);
    expect(score.notesHit).toBe(1);
  });

  it('gives an out-of-tune run nothing', () => {
    const state = scoreFrames([melody[0] as PracticeNote], 71, 1);
    const score = practiceScore(state);

    expect(score.score).toBe(0);
    expect(score.accuracy).toBe(0);
    expect(score.notesHit).toBe(0);
  });

  it('ignores rests instead of counting them as misses', () => {
    let state = scoreFrames([melody[0] as PracticeNote], 69, 1);
    const before = state.targetSeconds;
    state = scorePracticeFrame(state, { at: 2.2, midi: null }, { frameSeconds: 0.05 });

    expect(state.targetSeconds).toBeCloseTo(before);
    expect(state.combo).toBe(1);
  });

  it('does not count a seek gap as missed target time', () => {
    let state = scoreFrames(melody, 69, 1);
    const before = state.targetSeconds;
    state = scorePracticeFrame(state, { at: 12, midi: 69 }, { frameSeconds: 0.05 });

    expect(state.targetSeconds).toBeCloseTo(before);
    expect(state.combo).toBe(0);
  });

  it('needs enough in-tune time before a note is hit', () => {
    const short = scoreFrames([melody[0] as PracticeNote], 69, 1, 2);
    const long = scoreFrames([melody[0] as PracticeNote], 69, 1, 12);

    expect(practiceScore(short).notesHit).toBe(0);
    expect(practiceScore(long).notesHit).toBe(1);
  });

  it('counts a streak of notes and keeps the longest', () => {
    let state = newPracticeScore(melody);
    for (let index = 0; index < 10; index += 1) {
      state = scorePracticeFrame(
        state,
        { at: 1 + index * 0.05, midi: 69 },
        { frameSeconds: 0.05 },
      );
    }
    for (let index = 0; index < 12; index += 1) {
      state = scorePracticeFrame(
        state,
        { at: 1.5 + index * 0.05, midi: 72 },
        { frameSeconds: 0.05 },
      );
    }
    // Two misses are needed to break the display streak, so a single
    // uncertain frame does not wipe it out.
    state = scorePracticeFrame(state, { at: 2.1, midi: 60 }, { frameSeconds: 0.05 });
    expect(state.combo).toBe(2);
    state = scorePracticeFrame(state, { at: 2.15, midi: 60 }, { frameSeconds: 0.05 });
    expect(state.combo).toBe(0);
    expect(practiceScore(state).longestStreak).toBe(2);
  });

  it('resets cleanly for another run', () => {
    const state = scoreFrames(melody, 69, 1);
    const reset = newPracticeScore(melody);

    expect(practiceScore(state).notesHit).toBe(1);
    expect(practiceScore(reset).notesHit).toBe(0);
    expect(practiceScore(reset).score).toBe(0);
  });
});

describe('normalisation', () => {
  it('drops malformed notes and sorts the rest', () => {
    const notes = normalisePracticeNotes([
      { start: 2, end: 3, midi: 72, confidence: 2 },
      { start: -1, end: 0, midi: 60, confidence: 1 },
      { start: 0, end: 1, midi: 69 },
      'nonsense',
    ]);

    expect(notes.map((note) => note.midi)).toEqual([69, 72]);
    expect(notes[1]?.confidence).toBe(1);
  });

  it('clamps a score snapshot into range', () => {
    const score = normalisePracticeScore({
      score: 140,
      accuracy: -3,
      notesHit: 9,
      notesTotal: 4,
      combo: -2,
      longestStreak: 3.7,
    });

    expect(score.score).toBe(100);
    expect(score.accuracy).toBe(0);
    expect(score.notesHit).toBe(4);
    expect(score.combo).toBe(0);
    expect(score.longestStreak).toBe(4);
  });

  it('keeps a ready analysis without notes out of the overlay', () => {
    const empty = normalisePracticeAnalysis({ state: 'ready', progress: 1, notes: [] });
    const malformed = normalisePracticeAnalysis({ state: 'nonsense', progress: 4 });

    expect(empty.state).toBe('ready');
    expect(empty.notes).toBeNull();
    expect(malformed.state).toBe('analyzing');
    expect(malformed.progress).toBe(1);
  });

  it('bounds a live report before the page draws with it', () => {
    const live = normalisePracticeLive({
      listening: 'yes',
      atSeconds: -4,
      mic: { hz: -2, midi: 200, level: 4, clarity: -1 },
      target: { index: -3, midi: 69, start: 2, end: 1 },
      cents: 9000,
      score: { score: 200, notesTotal: 3, notesHit: 9 },
    });

    expect(live.listening).toBe(false);
    expect(live.atSeconds).toBe(0);
    expect(live.mic?.hz).toBeNull();
    expect(live.mic?.midi).toBe(127);
    expect(live.mic?.level).toBe(1);
    expect(live.mic?.clarity).toBe(0);
    expect(live.target).toBeNull();
    expect(live.cents).toBe(1200);
    expect(live.score.score).toBe(100);
    expect(live.score.notesHit).toBe(3);
  });
});

describe('analyseMelody', () => {
  it('finds a note in a copied vocal-like stem', () => {
    const rate = 16_000;
    const samples = new Float32Array(rate);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = 0.4 * Math.sin((2 * Math.PI * 440 * index) / rate);
    }
    const notes = analyseMelody(samples, rate);

    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.midi).toBe(69);
  });

  it('keeps a strong second harmonic on the fundamental', () => {
    const notes = analyseMelody(partials([[220, 0.15], [440, 0.5]], 1), 16_000);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(57);
  });

  it('keeps a weak fundamental under a strong second harmonic', () => {
    const notes = analyseMelody(partials([[220, 0.03], [440, 0.45]], 1), 16_000);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(57);
  });

  it('keeps vibrato on a sustained note', () => {
    const notes = analyseMelody(vibrato(440, 1), 16_000);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(69);
  });

  it('keeps a wide vibrato from becoming a run of fragments', () => {
    const notes = analyseMelody(vibrato(440, 1, 60), 16_000);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(69);
  });

  it('has nothing to show for a breath or noise', () => {
    const notes = analyseMelody(noise(1), 16_000);

    expect(notes).toEqual([]);
  });

  it('drops a short high burst in the middle of a sung note', () => {
    const rate = 16_000;
    const samples = new Float32Array(rate);
    for (let index = 0; index < samples.length; index += 1) {
      const hz = index >= 0.45 * rate && index < 0.53 * rate ? 880 : 440;
      samples[index] = 0.4 * Math.sin((2 * Math.PI * hz * index) / rate);
    }
    const notes = analyseMelody(samples, rate);

    expect(notes.map((note) => note.midi)).toEqual([69]);
  });

  it('does not invent a note outside the measured range', () => {
    const notes = analyseMelody(partials([[440, 0.4]], 1), 16_000, {
      range: { lowMidi: 55, highMidi: 64 },
    });

    expect(notes).toEqual([]);
  });

  it('has nothing to show for a stem with no tone', () => {
    const notes = analyseMelody(new Float32Array(16_000), 16_000);

    expect(notes).toEqual([]);
  });
});
