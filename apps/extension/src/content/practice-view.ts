import { noteName } from '../audio/pitch.ts';
import {
  normalisePracticeScore,
  targetAt,
  type PracticeAnalysis,
  type PracticeLive,
  type PracticeNote,
  type PracticeScore,
} from '../audio/practice.ts';

/**
 * What the practice overlay draws, worked out from the guide melody and the
 * latest live report.
 *
 * Pure, so the rectangle geometry and the colour of the pitch marker are tests
 * rather than something only a video can check. The DOM half in
 * `practice-overlay.ts` takes fractions from here and puts them on screen: the
 * note field, the playhead and the marker are all nought to one, which is what
 * lets the overlay scale with the player, with a resize and with fullscreen.
 */

/** How much of the song the note field shows at once. */
export const PRACTICE_WINDOW_SECONDS = 8;

/** Where the playhead sits across the field, leaving a little of the past visible. */
export const PRACTICE_PLAYHEAD = 0.32;

/** The smallest slice of the melody a field can show without changing scale. */
const MIN_SEMITONES = 12;

/** Smallest and largest height of one note rectangle, as fractions of the field. */
const MIN_NOTE_HEIGHT = 0.035;
const MAX_NOTE_HEIGHT = 0.18;

/** The narrowest a note draws, so a short or clipped note still reads as one. */
export const PRACTICE_MIN_NOTE_WIDTH = 0.012;

/** The narrowest note that can carry a pitch label without cropping it. */
export const PRACTICE_LABEL_MIN_WIDTH = 0.06;

/**
 * How close two notes can sit before one of them gives up its label. The
 * horizontal gap is a fraction of the field; the vertical one keeps labels on
 * neighbouring pitch rows from crowding each other.
 */
const LABEL_GAP_X = 0.014;
const LABEL_GAP_Y = 0.02;

export type PracticeTone = 'perfect' | 'good' | 'off' | 'idle';

export interface PracticeLaneNote {
  readonly index: number;
  readonly midi: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** Fractions of the note field: left and width across, top and height down. */
  readonly left: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
  readonly current: boolean;
  readonly past: boolean;
  /** Whether the pitch name fits inside the rectangle. */
  readonly label: boolean;
}

/** A horizontal rule of the pitch grid, positioned like a note. */
export interface PracticeGridLine {
  readonly midi: number;
  readonly y: number;
  /** C rows are a little stronger than the semitones between them. */
  readonly strong: boolean;
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
  /** The faint pitch rows behind the notes, positioned across the field. */
  readonly grid: readonly PracticeGridLine[];
  /** Where the playhead is across the field, nought to one. */
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
  /** `video.currentTime`, the clock the note field scrolls by. */
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

/** The speed of the marker against the target, in the three colours the field has. */
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

/**
 * The pitch span the note field shows, wide enough to keep every visible note
 * in frame. A singer near the guide joins the span; one an octave and a half
 * away is clamped to the field rather than shrinking every rectangle.
 */
export function practicePitchRange(
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
    low = Math.min(low, micMidi);
    high = Math.max(high, micMidi);
  }
  const span = Math.max(MIN_SEMITONES, high - low + 4);
  const centre = (low + high) / 2;
  return { low: centre - span / 2, high: centre + span / 2 };
}

/** A pitch row for every semitone in the range, with C rows picked out. */
export function practicePitchGrid(
  low: number,
  high: number,
): readonly PracticeGridLine[] {
  const span = high - low;
  if (!Number.isFinite(span) || span <= 0) {
    return [];
  }
  const lines: PracticeGridLine[] = [];
  for (let midi = Math.ceil(low); midi <= Math.floor(high); midi += 1) {
    const y = (high - midi) / span;
    // A line on the very edge would sit under the field's mask and look like a
    // border rather than a pitch row.
    if (y <= 0.001 || y >= 0.999) {
      continue;
    }
    lines.push({ midi, y, strong: midi % 12 === 0 });
  }
  return lines;
}

/** Just enough of a lane note for the label planner: no names or times. */
export type PracticeNoteBox = Pick<
  PracticeLaneNote,
  'index' | 'left' | 'width' | 'top' | 'height' | 'current' | 'past'
>;

/**
 * Chooses which rectangles wear a pitch label.
 *
 * A label needs room, so narrow notes never get one. In a dense run the
 * current note keeps its label first, then the wider and earlier upcoming
 * notes; a note gives way when another chosen label sits within a label's
 * width and height of it. That keeps labels off clipped short notes and stops
 * a trill or a fast phrase from turning into a wall of text.
 */
export function practiceNoteLabels(notes: readonly PracticeNoteBox[]): readonly number[] {
  const rank = (note: PracticeNoteBox): number =>
    note.current ? 2 : note.past ? 0 : 1;
  const order = notes
    .filter((note) => Number.isFinite(note.width) && note.width >= PRACTICE_LABEL_MIN_WIDTH)
    .slice()
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        b.width - a.width ||
        a.index - b.index,
    );
  const chosen: PracticeNoteBox[] = [];
  for (const note of order) {
    const crowded = chosen.some((other) => {
      const gapX = Math.max(
        other.left - (note.left + note.width),
        note.left - (other.left + other.width),
        0,
      );
      const gapY = Math.max(
        other.top - (note.top + note.height),
        note.top - (other.top + other.height),
        0,
      );
      return gapX < LABEL_GAP_X && gapY < LABEL_GAP_Y;
    });
    if (!crowded) {
      chosen.push(note);
    }
  }
  return chosen.map((note) => note.index).sort((a, b) => a - b);
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
      grid: [],
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
      grid: [],
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
      grid: [],
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
  const target = targetAt(notes, at);
  const targetIndex = target?.index ?? null;
  const micMidi = live?.mic?.midi ?? null;
  const range = practicePitchRange(
    notes.filter((note) => note.end >= leftTime && note.start <= rightTime),
    micMidi,
  );
  const span = Math.max(1e-6, range.high - range.low);
  const grid = practicePitchGrid(range.low, range.high);

  const geometry: Omit<PracticeLaneNote, 'label'>[] = [];
  for (const [index, note] of notes.entries()) {
    if (note.end < leftTime || note.start > rightTime) {
      continue;
    }
    const from = clamp(note.start, leftTime, rightTime);
    const to = clamp(note.end, leftTime, rightTime);
    const height = Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, 0.8 / span));
    const top = clamp((range.high - note.midi) / span - height / 2, 0, 1 - height);
    const current = targetIndex === index;
    const width = Math.max(PRACTICE_MIN_NOTE_WIDTH, (to - from) / windowSeconds);
    geometry.push({
      index,
      midi: note.midi,
      name: noteName(note.midi),
      start: note.start,
      end: note.end,
      left: clamp((from - leftTime) / windowSeconds, 0, 1 - width),
      width,
      top,
      height,
      current,
      past: !current && note.end < at,
    });
  }
  const labelled = new Set(practiceNoteLabels(geometry));
  const lane: PracticeLaneNote[] = geometry.map((note) => ({
    ...note,
    label: labelled.has(note.index),
  }));

  const targetMidi = target?.note.midi ?? null;
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
    grid,
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
