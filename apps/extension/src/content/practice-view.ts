import { noteName } from '../audio/pitch.ts';
import {
  normalisePracticeScore,
  type PracticeAnalysis,
  type PracticeLive,
  type PracticeNote,
  type PracticeScore,
} from '../audio/practice.ts';

/**
 * What the practice overlay draws, worked out from the guide melody and the
 * latest live report.
 *
 * Pure, so the lane geometry and the colour of the pitch marker are tests
 * rather than something only a video can check. The DOM half in
 * `practice-overlay.ts` takes fractions from here and puts them on screen: the
 * note lane, the playhead and the marker are all nought to one, which is what
 * lets the overlay scale with the player and with fullscreen.
 */

/** How much of the song the lane shows at once. */
export const PRACTICE_WINDOW_SECONDS = 8;

/** Where the playhead sits across the lane, leaving a little of the past visible. */
export const PRACTICE_PLAYHEAD = 0.32;

/** The smallest slice of the melody a lane can show without changing scale. */
const MIN_SEMITONES = 12;

export type PracticeTone = 'perfect' | 'good' | 'off' | 'idle';

export interface PracticeLaneNote {
  readonly index: number;
  readonly midi: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** Fractions of the lane: left and width across, top and height down. */
  readonly left: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
  readonly current: boolean;
  readonly past: boolean;
}

export interface PracticeMarker {
  /** Always the playhead, kept explicit so the drawing has one number. */
  readonly x: number;
  readonly y: number;
  readonly tone: PracticeTone;
  readonly midi: number;
  readonly name: string;
}

export interface PracticeOverlayView {
  readonly mode: 'hidden' | 'learning' | 'listening' | 'ended' | 'error';
  readonly notes: readonly PracticeLaneNote[];
  /** Where the playhead is across the lane, nought to one. */
  readonly playhead: number;
  readonly marker: PracticeMarker | null;
  readonly currentName: string | null;
  readonly score: PracticeScore;
  readonly listening: boolean;
  readonly learning: { readonly progress: number | null; readonly detail: string } | null;
  readonly summary: PracticeScore | null;
  readonly error: string | null;
}

export interface PracticeOverlayInput {
  readonly analysis: PracticeAnalysis | null;
  readonly live: PracticeLive | null;
  /** The final score while the end card is up, or null during a run. */
  readonly summary?: PracticeScore | null;
  /** `video.currentTime`, the clock the lane scrolls by. */
  readonly at: number;
}

const ZERO_SCORE: PracticeScore = {
  score: 0,
  accuracy: 0,
  notesHit: 0,
  notesTotal: 0,
  combo: 0,
  longestStreak: 0,
  inTuneSeconds: 0,
  targetSeconds: 0,
};

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The speed of the marker against the target, in the three colours the lane has. */
export function practiceTone(cents: number | null): PracticeTone {
  if (cents === null || !Number.isFinite(cents)) {
    return 'idle';
  }
  const distance = Math.abs(cents);
  if (distance <= 50) {
    return 'perfect';
  }
  if (distance <= 100) {
    return 'good';
  }
  return 'off';
}

/** The pitch span the lane shows, wide enough to keep every visible note in frame. */
function pitchRange(
  notes: readonly PracticeNote[],
  micMidi: number | null,
): { readonly low: number; readonly high: number } {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    low = Math.min(low, note.midi);
    high = Math.max(high, note.midi);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = (micMidi ?? 60) - 6;
    high = (micMidi ?? 60) + 6;
  } else if (
    micMidi !== null &&
    Number.isFinite(micMidi) &&
    micMidi >= low - 12 &&
    micMidi <= high + 12
  ) {
    // A singer near the guide stays in frame; one an octave and a half away
    // is clamped to the lane rather than shrinking every note.
    low = Math.min(low, micMidi);
    high = Math.max(high, micMidi);
  }
  const span = Math.max(MIN_SEMITONES, high - low + 4);
  const centre = (low + high) / 2;
  return { low: centre - span / 2, high: centre + span / 2 };
}

export function practiceOverlayView(input: PracticeOverlayInput): PracticeOverlayView {
  const analysis = input.analysis;
  const live = input.live;
  const at = Math.max(0, finite(input.at, 0));
  const summary = input.summary ?? null;
  const score = normalisePracticeScore(live?.score ?? ZERO_SCORE);
  const listening = live?.listening === true;

  const mode: PracticeOverlayView['mode'] =
    summary !== null
      ? 'ended'
      : analysis === null
        ? 'hidden'
        : analysis.state === 'error'
          ? 'error'
          : analysis.state === 'analyzing'
            ? 'learning'
            : 'listening';

  if (mode === 'hidden' || mode === 'error') {
    return {
      mode,
      notes: [],
      playhead: PRACTICE_PLAYHEAD,
      marker: null,
      currentName: null,
      score,
      listening: false,
      learning: null,
      summary: null,
      error: mode === 'error' ? (analysis?.detail ?? 'Practice stopped.') : null,
    };
  }

  if (mode === 'learning') {
    return {
      mode,
      notes: [],
      playhead: PRACTICE_PLAYHEAD,
      marker: null,
      currentName: null,
      score,
      listening: false,
      learning: {
        progress: analysis?.progress ?? null,
        detail: analysis?.detail ?? 'Learning the guide melody.',
      },
      summary: null,
      error: null,
    };
  }

  if (mode === 'ended') {
    return {
      mode,
      notes: [],
      playhead: PRACTICE_PLAYHEAD,
      marker: null,
      currentName: null,
      score: summary ?? score,
      listening: false,
      learning: null,
      summary: normalisePracticeScore(summary),
      error: null,
    };
  }

  const notes = analysis?.state === 'ready' ? (analysis.notes ?? []) : [];
  const windowSeconds = PRACTICE_WINDOW_SECONDS;
  const leftTime = at - windowSeconds * PRACTICE_PLAYHEAD;
  const rightTime = leftTime + windowSeconds;
  const targetIndex = live?.target?.index ?? null;
  const micMidi = live?.mic?.midi ?? null;
  const range = pitchRange(
    notes.filter((note) => note.end >= leftTime && note.start <= rightTime),
    micMidi,
  );
  const span = Math.max(1e-6, range.high - range.low);

  const lane: PracticeLaneNote[] = [];
  for (const [index, note] of notes.entries()) {
    if (note.end < leftTime || note.start > rightTime) {
      continue;
    }
    const from = clamp(note.start, leftTime, rightTime);
    const to = clamp(note.end, leftTime, rightTime);
    const height = Math.max(0.035, Math.min(0.18, 0.8 / span));
    const top = clamp((range.high - note.midi) / span - height / 2, 0, 1 - height);
    lane.push({
      index,
      midi: note.midi,
      name: noteName(note.midi),
      start: note.start,
      end: note.end,
      left: (from - leftTime) / windowSeconds,
      width: Math.max(0.006, (to - from) / windowSeconds),
      top,
      height,
      current: targetIndex === null ? at >= note.start && at <= note.end : targetIndex === index,
      past: note.end < at,
    });
  }

  const current = lane.find((note) => note.current) ?? null;
  const targetMidi = live?.target?.midi ?? current?.midi ?? null;
  const marker =
    micMidi === null || !Number.isFinite(micMidi)
      ? null
      : {
          x: PRACTICE_PLAYHEAD,
          y: clamp((range.high - micMidi) / span, 0, 1),
          tone: practiceTone(live?.cents ?? null),
          midi: micMidi,
          name: noteName(micMidi),
        };

  return {
    mode,
    notes: lane,
    playhead: PRACTICE_PLAYHEAD,
    marker,
    currentName: targetMidi === null ? null : noteName(targetMidi),
    score,
    listening,
    learning: null,
    summary: null,
    error: null,
  };
}
