import {
  PITCH_CLARITY,
  PITCH_MAX_HZ,
  PITCH_MIN_HZ,
  PITCH_MIN_LEVEL,
  detectPitch,
  downsampleForPitch,
  type PitchFrame,
} from './pitch.ts';

/**
 * The guide melody, the score, and the arithmetic between them.
 *
 * The separated vocal stem is monophonic only by hope: a duet, a harmony or a
 * doubled line gives the detector more than one answer. This pass takes the
 * strongest line in each frame and follows it, which is the right guide for a
 * solo verse and an honest approximation for a chorus. Two simultaneous target
 * lines are deliberately out of scope; the lane would need a second row and
 * the score would need to choose which line the singer meant.
 *
 * Everything here is pure. The worker analyses a copied stem, the offscreen
 * document feeds microphone readings through the same reducer, and both are
 * exercised by synthetic frames in `test/practice.test.ts`.
 */

/** One note the singer is asked to match, in song seconds. */
export interface PracticeNote {
  readonly start: number;
  readonly end: number;
  /** The nearest whole MIDI note, 69 for A4. */
  readonly midi: number;
  /** Mean detector clarity over the frames that made the note, nought to one. */
  readonly confidence: number;
}

/**
 * The range the song actually measured, as whole MIDI notes.
 *
 * The song card takes the fifth and ninety-fifth percentiles of its confident
 * vocal frames, so this is what the singer was heard to reach rather than the
 * one scream at either end. Practice uses it as a clamp: a note outside it is
 * a detector reading, not a guide.
 */
export interface PracticeRange {
  readonly lowMidi: number;
  readonly highMidi: number;
}

/** A note and its position in the timeline, which is what an overlay indexes by. */
export interface PracticeTarget {
  readonly index: number;
  readonly note: PracticeNote;
}

/** What the overlay and the end card show. All percentages are nought to a hundred. */
export interface PracticeScore {
  readonly score: number;
  readonly accuracy: number;
  readonly notesHit: number;
  readonly notesTotal: number;
  readonly combo: number;
  readonly longestStreak: number;
  readonly inTuneSeconds: number;
  readonly targetSeconds: number;
}

/** The reducer's state. Kept separate from the snapshot so a report stays small. */
export interface PracticeScoreState {
  readonly notes: readonly PracticeNote[];
  readonly targetSeconds: number;
  readonly perfectSeconds: number;
  readonly goodSeconds: number;
  readonly coverage: readonly number[];
  readonly hit: readonly boolean[];
  readonly notesHit: number;
  readonly combo: number;
  readonly longestStreak: number;
  readonly missRun: number;
  readonly lastAt: number | null;
}

/** One microphone frame, already reduced to a note or an uncertain silence. */
export interface PracticeFrame {
  readonly at: number;
  /** Fractional MIDI, or null when the detector had no confident answer. */
  readonly midi: number | null;
}

export interface ScoreOptions {
  /** How much target time one frame represents. */
  readonly frameSeconds?: number;
  /** How far ahead or behind a note still counts as that note. */
  readonly toleranceSeconds?: number;
  readonly perfectCents?: number;
  readonly goodCents?: number;
  /** A note is hit once this fraction of it has been sung in tune. */
  readonly hitFraction?: number;
  readonly minHitSeconds?: number;
  /** A jump larger than this is a seek, not a missed phrase. */
  readonly seekGapSeconds?: number;
  /** Consecutive misses before the combo display resets. */
  readonly missGrace?: number;
}

const SCORE_DEFAULTS = {
  frameSeconds: 0.04,
  toleranceSeconds: 0.15,
  perfectCents: 50,
  goodCents: 100,
  hitFraction: 0.3,
  minHitSeconds: 0.08,
  seekGapSeconds: 0.75,
  missGrace: 2,
} as const;

/** How long a note has to be sung in tune before it counts as hit. */
export function hitSeconds(note: PracticeNote, options: ScoreOptions = {}): number {
  const duration = Math.max(0, note.end - note.start);
  const wanted = Math.max(
    positive(options.minHitSeconds, SCORE_DEFAULTS.minHitSeconds),
    duration * positive(options.hitFraction, SCORE_DEFAULTS.hitFraction),
  );
  return Math.min(duration, wanted);
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The note under a moment, with a little room either side for a singer who is
 * early or late. Rests have no note, which is how they are ignored rather than
 * scored as misses.
 */
export function targetAt(
  notes: readonly PracticeNote[],
  at: number,
  toleranceSeconds: number = SCORE_DEFAULTS.toleranceSeconds,
): PracticeTarget | null {
  if (!Number.isFinite(at)) {
    return null;
  }
  const tolerance = Number.isFinite(toleranceSeconds) && toleranceSeconds >= 0
    ? toleranceSeconds
    : SCORE_DEFAULTS.toleranceSeconds;
  let best: { readonly index: number; readonly distance: number } | null = null;
  for (const [index, note] of notes.entries()) {
    if (at < note.start - tolerance || at > note.end + tolerance) {
      continue;
    }
    const distance = at < note.start ? note.start - at : at > note.end ? at - note.end : 0;
    if (
      best === null ||
      distance < best.distance - 1e-9 ||
      (Math.abs(distance - best.distance) <= 1e-9 &&
        note.confidence > (notes[best.index]?.confidence ?? 0))
    ) {
      best = { index, distance };
    }
  }
  return best === null ? null : { index: best.index, note: notes[best.index] as PracticeNote };
}

/** The state before the first frame, with every note still unhit. */
export function newPracticeScore(notes: readonly PracticeNote[]): PracticeScoreState {
  return {
    notes,
    targetSeconds: 0,
    perfectSeconds: 0,
    goodSeconds: 0,
    coverage: notes.map(() => 0),
    hit: notes.map(() => false),
    notesHit: 0,
    combo: 0,
    longestStreak: 0,
    missRun: 0,
    lastAt: null,
  };
}

/**
 * Feed one microphone frame to the score.
 *
 * The frame's time is the projected video clock, not the microphone clock:
 * that is what keeps the guide lane and the singer's marker on the same
 * timeline. A backwards jump, or a forward one larger than a phrase, is a
 * seek. The gap it skipped is not added to the denominator and is not counted
 * as a miss.
 */
export function scorePracticeFrame(
  state: PracticeScoreState,
  frame: PracticeFrame,
  options: ScoreOptions = {},
): PracticeScoreState {
  if (!Number.isFinite(frame.at)) {
    return state;
  }
  const seekGap = positive(options.seekGapSeconds, SCORE_DEFAULTS.seekGapSeconds);
  if (
    state.lastAt !== null &&
    (frame.at < state.lastAt - 0.05 || frame.at - state.lastAt > seekGap)
  ) {
    return { ...state, lastAt: frame.at, combo: 0, missRun: 0 };
  }

  const target = targetAt(
    state.notes,
    frame.at,
    positive(options.toleranceSeconds, SCORE_DEFAULTS.toleranceSeconds),
  );
  if (target === null) {
    // A rest is not an opportunity to lose the streak, and not target time.
    return { ...state, lastAt: frame.at, missRun: 0 };
  }

  const frameSeconds = positive(options.frameSeconds, SCORE_DEFAULTS.frameSeconds);
  const perfectCents = positive(options.perfectCents, SCORE_DEFAULTS.perfectCents);
  const goodCents = Math.max(
    perfectCents,
    positive(options.goodCents, SCORE_DEFAULTS.goodCents),
  );
  const missGrace = Math.max(1, Math.round(positive(options.missGrace, SCORE_DEFAULTS.missGrace)));
  const cents =
    frame.midi === null ? Number.NaN : (frame.midi - target.note.midi) * 100;
  const inTune = Number.isFinite(cents) && Math.abs(cents) <= goodCents;

  if (!inTune) {
    const misses = state.missRun + 1;
    return {
      ...state,
      lastAt: frame.at,
      targetSeconds: state.targetSeconds + frameSeconds,
      missRun: misses,
      combo: misses >= missGrace ? 0 : state.combo,
    };
  }

  const perfect = Math.abs(cents) <= perfectCents;
  const coverage = state.coverage.slice();
  coverage[target.index] = (state.coverage[target.index] ?? 0) + frameSeconds;
  let hit: readonly boolean[] = state.hit;
  let notesHit = state.notesHit;
  let combo = state.combo;
  let longestStreak = state.longestStreak;
  if (!(state.hit[target.index] ?? false) && coverage[target.index]! >= hitSeconds(target.note, options)) {
    const nextHit = state.hit.slice();
    nextHit[target.index] = true;
    hit = nextHit;
    notesHit += 1;
    combo += 1;
    longestStreak = Math.max(longestStreak, combo);
  }

  return {
    ...state,
    targetSeconds: state.targetSeconds + frameSeconds,
    perfectSeconds: state.perfectSeconds + (perfect ? frameSeconds : 0),
    goodSeconds: state.goodSeconds + (perfect ? 0 : frameSeconds),
    coverage,
    hit,
    notesHit,
    combo,
    longestStreak,
    missRun: 0,
    lastAt: frame.at,
  };
}

/** The small, serialisable view of a score. */
export function practiceScore(state: PracticeScoreState): PracticeScore {
  const target = Math.max(0, state.targetSeconds);
  const inTune = state.perfectSeconds + state.goodSeconds;
  const weighted = state.perfectSeconds + state.goodSeconds * 0.7;
  return {
    score: target <= 0 ? 0 : clamp((weighted / target) * 100, 0, 100),
    accuracy: target <= 0 ? 0 : clamp((inTune / target) * 100, 0, 100),
    notesHit: state.notesHit,
    notesTotal: state.notes.length,
    combo: state.combo,
    longestStreak: state.longestStreak,
    inTuneSeconds: inTune,
    targetSeconds: target,
  };
}

export type PracticeAnalysisState = 'analyzing' | 'ready' | 'error';

/** The one-shot analysis state the panel and the overlay both read. */
export interface PracticeAnalysis {
  readonly state: PracticeAnalysisState;
  /** Nought to one while analysing, null when there is no bar. */
  readonly progress: number | null;
  /** The guide melody once it is ready, null before then. */
  readonly notes: readonly PracticeNote[] | null;
  readonly detail: string | null;
}

/** One live microphone reading, with every number in the range the lane wants. */
export interface PracticeMicReading {
  readonly hz: number | null;
  readonly midi: number | null;
  readonly level: number;
  readonly clarity: number;
}

/** The target the live marker should be compared with. */
export interface PracticeLiveTarget {
  readonly index: number;
  readonly midi: number;
  readonly start: number;
  readonly end: number;
}

/** The throttled live report: enough to draw a marker and a score, no audio. */
export interface PracticeLive {
  /** Whether the video is playing at rate one and not in an ad. */
  readonly listening: boolean;
  readonly atSeconds: number | null;
  readonly mic: PracticeMicReading | null;
  readonly target: PracticeLiveTarget | null;
  /** How far the singer is from the target, positive sharp, or null in a rest. */
  readonly cents: number | null;
  readonly score: PracticeScore;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A note from a message, or null when the message did not contain one. */
export function normalisePracticeNote(raw: unknown): PracticeNote | null {
  const stored = recordOf(raw);
  const start = numberOrNull(stored['start']);
  const end = numberOrNull(stored['end']);
  const midi = numberOrNull(stored['midi']);
  if (start === null || end === null || midi === null || start < 0 || end <= start) {
    return null;
  }
  return {
    start,
    end,
    midi: Math.round(clamp(midi, 0, 127)),
    confidence: clamp(numberOrNull(stored['confidence']) ?? 0, 0, 1),
  };
}

/** A sorted note list, with malformed notes dropped rather than displayed. */
export function normalisePracticeNotes(raw: unknown): PracticeNote[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const notes: PracticeNote[] = [];
  for (const item of raw) {
    const note = normalisePracticeNote(item);
    if (note !== null) {
      notes.push(note);
    }
  }
  notes.sort((left, right) => left.start - right.start);
  return notes;
}

/** A score snapshot whose numbers are safe to draw. */
export function normalisePracticeScore(raw: unknown): PracticeScore {
  const stored = recordOf(raw);
  const notesTotal = Math.max(0, Math.round(numberOrNull(stored['notesTotal']) ?? 0));
  return {
    score: clamp(numberOrNull(stored['score']) ?? 0, 0, 100),
    accuracy: clamp(numberOrNull(stored['accuracy']) ?? 0, 0, 100),
    notesHit: Math.min(notesTotal, Math.max(0, Math.round(numberOrNull(stored['notesHit']) ?? 0))),
    notesTotal,
    combo: Math.max(0, Math.round(numberOrNull(stored['combo']) ?? 0)),
    longestStreak: Math.max(0, Math.round(numberOrNull(stored['longestStreak']) ?? 0)),
    inTuneSeconds: Math.max(0, numberOrNull(stored['inTuneSeconds']) ?? 0),
    targetSeconds: Math.max(0, numberOrNull(stored['targetSeconds']) ?? 0),
  };
}

/** An analysis report from the offscreen document, made safe for the page. */
export function normalisePracticeAnalysis(raw: unknown): PracticeAnalysis {
  const stored = recordOf(raw);
  const state =
    stored['state'] === 'ready' || stored['state'] === 'error'
      ? stored['state']
      : 'analyzing';
  const progress = numberOrNull(stored['progress']);
  const notes = normalisePracticeNotes(stored['notes']);
  return {
    state,
    progress: progress === null ? null : clamp(progress, 0, 1),
    notes: state === 'ready' && notes.length > 0 ? notes : null,
    detail: typeof stored['detail'] === 'string' && stored['detail'] !== '' ? stored['detail'] : null,
  };
}

/** A live report from the offscreen document, with a bounded shape. */
export function normalisePracticeLive(raw: unknown): PracticeLive {
  const stored = recordOf(raw);
  const mic = recordOf(stored['mic']);
  const hz = numberOrNull(mic['hz']);
  const midi = numberOrNull(mic['midi']);
  const target = recordOf(stored['target']);
  const targetMidi = numberOrNull(target['midi']);
  const targetStart = numberOrNull(target['start']);
  const targetEnd = numberOrNull(target['end']);
  const cents = numberOrNull(stored['cents']);
  const at = numberOrNull(stored['atSeconds']);
  return {
    listening: stored['listening'] === true,
    atSeconds: at === null ? null : Math.max(0, at),
    mic:
      stored['mic'] === null
        ? null
        : {
            hz: hz !== null && hz > 0 ? hz : null,
            midi: midi === null ? null : clamp(midi, 0, 127),
            level: clamp(numberOrNull(mic['level']) ?? 0, 0, 1),
            clarity: clamp(numberOrNull(mic['clarity']) ?? 0, 0, 1),
          },
    target:
      targetMidi === null || targetStart === null || targetEnd === null || targetEnd <= targetStart
        ? null
        : {
            index: Math.max(0, Math.round(numberOrNull(target['index']) ?? 0)),
            midi: Math.round(clamp(targetMidi, 0, 127)),
            start: Math.max(0, targetStart),
            end: Math.max(0, targetEnd),
          },
    cents: cents === null ? null : clamp(cents, -1200, 1200),
    score: normalisePracticeScore(stored['score']),
  };
}

/**
 * The analysis rate, frame and hop.
 *
 * Sixteen kilohertz is plenty for a guide melody and a quarter of the memory
 * and arithmetic of the original stem. The hop is thirty-two milliseconds,
 * which is finer than a singer can move and coarse enough that a four-minute
 * song is a few seconds of work in a worker rather than a minute of it.
 */
export const ANALYSIS_RATE = 16_000;
export const ANALYSIS_FRAME = 1024;
export const ANALYSIS_HOP = 512;

export interface MelodyOptions {
  readonly analysisRate?: number;
  readonly frameSize?: number;
  readonly hopSize?: number;
  /** The song's measured vocal range, when the song card has one. */
  readonly range?: PracticeRange | null;
  readonly onProgress?: (fraction: number) => void;
}

export interface SegmentOptions {
  /** How much song time one frame covers. */
  readonly frameSeconds?: number;
  readonly minNoteSeconds?: number;
  /** Same-pitch gaps up to this long are the same note, not two. */
  readonly gapSeconds?: number;
  readonly minClarity?: number;
  /** The song's measured vocal range, or null to keep the detector's answer. */
  readonly range?: PracticeRange | null;
}

interface Run {
  midi: number;
  start: number;
  end: number;
  clarity: number;
  frames: number;
}

/**
 * How the frames become notes.
 *
 * The median sees five frames, not three: at a thirty-two millisecond hop that
 * is a sixth of a second, long enough to outvote one noisy frame and short
 * enough to keep a vibrato on the note it belongs to. Anything shorter than
 * {@link MIN_NOTE_SECONDS} is a consonant, a breath or a detector flicker, not
 * a guide note. The local energy window is what stops a quiet breath between
 * phrases from becoming a pitch at all.
 */
const MIN_NOTE_SECONDS = 0.13;
const GAP_SECONDS = 0.12;
const SMOOTHING_RADIUS = 2;
const LOCAL_ENERGY_SECONDS = 0.25;
const LOCAL_ENERGY_FRACTION = 0.15;
/** A high outlier shorter than this, with no neighbour at its pitch, is an error. */
const SPIKE_SECONDS = 0.25;
/** A one-off octave jump may be a little longer and still be a detector error. */
const OCTAVE_SPIKE_SECONDS = 0.3;
/** A run this far above both neighbours is an isolated high spike. */
const SPIKE_SEMITONES = 5;
const OCTAVE_SEMITONES = 12;

function practiceRange(range: PracticeRange | null | undefined): PracticeRange | null {
  if (range === null || range === undefined) {
    return null;
  }
  const low = Math.round(range.lowMidi);
  const high = Math.round(range.highMidi);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high > 127 || high < low) {
    return null;
  }
  return { lowMidi: low, highMidi: high };
}

/**
 * Frames into notes: smooth out the wobble, round to keys, merge agreements,
 * and drop what was too short or too uncertain to be a guide.
 */
export function segmentNotes(
  frames: readonly PitchFrame[],
  options: SegmentOptions = {},
): PracticeNote[] {
  const frameSeconds = positive(options.frameSeconds, ANALYSIS_HOP / ANALYSIS_RATE);
  const minNoteSeconds = positive(options.minNoteSeconds, MIN_NOTE_SECONDS);
  const gapSeconds = Math.max(0, options.gapSeconds ?? GAP_SECONDS);
  const minClarity = positive(options.minClarity, PITCH_CLARITY);
  const range = practiceRange(options.range);

  // A local median rather than one number for the whole take: a quiet phrase
  // after a loud chorus is still a note, while a breath between phrases is
  // below the floor even when the detector finds a period in it.
  const halfWindow = Math.max(1, Math.round(LOCAL_ENERGY_SECONDS / frameSeconds));
  const floors: number[] = frames.map((_, index) => {
    const levels: number[] = [];
    const first = Math.max(0, index - halfWindow);
    const last = Math.min(frames.length - 1, index + halfWindow);
    for (let at = first; at <= last; at += 1) {
      const level = frames[at]?.level;
      if (level !== undefined && Number.isFinite(level) && level > 0) {
        levels.push(level);
      }
    }
    if (levels.length === 0) {
      return PITCH_MIN_LEVEL;
    }
    levels.sort((left, right) => left - right);
    const median = levels[Math.floor(levels.length / 2)] ?? 0;
    return Math.max(PITCH_MIN_LEVEL, median * LOCAL_ENERGY_FRACTION);
  });

  const valid = (frame: PitchFrame | undefined, index: number): frame is PitchFrame =>
    frame !== undefined &&
    frame.midi !== null &&
    Number.isFinite(frame.midi) &&
    frame.clarity >= minClarity &&
    Number.isFinite(frame.level) &&
    frame.level >= (floors[index] ?? PITCH_MIN_LEVEL);

  // A frame outside a five-frame consensus is a detector flicker, not a new
  // note. A real note has a neighbour that agrees with it, so it keeps its own
  // pitch and its onset; a flicker or a vibrato crossing a semitone boundary
  // is held on the note already sounding. A silent frame clears the hold, so
  // a rest stays a rest.
  let sounding: number | null = null;
  const smoothed: (number | null)[] = frames.map((frame, index) => {
    if (!valid(frame, index)) {
      sounding = null;
      return null;
    }
    const around: number[] = [frame.midi as number];
    const rounded = Math.round(frame.midi as number);
    let supported = false;
    for (let offset = -SMOOTHING_RADIUS; offset <= SMOOTHING_RADIUS; offset += 1) {
      if (offset === 0) {
        continue;
      }
      const at = index + offset;
      const neighbour = frames[at];
      if (
        valid(neighbour, at) &&
        Math.abs(neighbour.at - frame.at) <= frameSeconds * (SMOOTHING_RADIUS + 0.6)
      ) {
        around.push(neighbour.midi as number);
        if (Math.round(neighbour.midi as number) === rounded) {
          supported = true;
        }
      }
    }
    if (supported) {
      sounding = rounded;
      return frame.midi;
    }
    if (sounding !== null) {
      return sounding;
    }
    around.sort((left, right) => left - right);
    const median = around[Math.floor(around.length / 2)] ?? (frame.midi as number);
    sounding = Math.round(median);
    return median;
  });

  const runs: Run[] = [];
  let current: Run | null = null;
  for (const [index, frame] of frames.entries()) {
    const midi = smoothed[index];
    if (midi === null || midi === undefined) {
      continue;
    }
    const whole = Math.round(midi);
    const at = frame.at;
    if (
      current !== null &&
      current.midi === whole &&
      at - current.end <= Math.max(frameSeconds * 1.6, gapSeconds)
    ) {
      current.end = Math.max(current.end, at + frameSeconds);
      current.clarity += frame.clarity;
      current.frames += 1;
      continue;
    }
    if (current !== null) {
      runs.push(current);
    }
    current = {
      midi: whole,
      start: at,
      end: at + frameSeconds,
      clarity: frame.clarity,
      frames: 1,
    };
  }
  if (current !== null) {
    runs.push(current);
  }

  const mergeSame = (input: readonly Run[], maxGap: number): Run[] => {
    const merged: Run[] = [];
    for (const run of input) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.midi === run.midi && run.start - last.end <= maxGap) {
        last.end = Math.max(last.end, run.end);
        last.clarity += run.clarity;
        last.frames += run.frames;
      } else {
        merged.push({ ...run });
      }
    }
    return merged;
  };

  const highSpike = (
    run: Run,
    previous: Run | undefined,
    following: Run | undefined,
  ): boolean => {
    if (previous?.midi === run.midi || following?.midi === run.midi) {
      return false;
    }
    const above = (other: Run | undefined): boolean =>
      other === undefined || run.midi - other.midi >= SPIKE_SEMITONES;
    const octave = (other: Run | undefined): boolean =>
      other !== undefined && Math.abs(run.midi - other.midi) === OCTAVE_SEMITONES;
    return (above(previous) && above(following)) || octave(previous) || octave(following);
  };

  const octaveSpike = (
    run: Run,
    previous: Run | undefined,
    following: Run | undefined,
  ): boolean => {
    if (previous?.midi === run.midi || following?.midi === run.midi) {
      return false;
    }
    const from = (other: Run | undefined): boolean =>
      other !== undefined && Math.abs(run.midi - other.midi) === OCTAVE_SEMITONES;
    return from(previous) || from(following);
  };

  // Fragments and one-off outliers are dropped. When the same pitch sits on
  // both sides, the notes are joined again: the spike was the error, not a
  // rest, so the phrase stays legato.
  let cleaned = mergeSame(runs, gapSeconds);
  for (let pass = 0; pass < 4; pass += 1) {
    const next: Run[] = [];
    let changed = false;
    for (let index = 0; index < cleaned.length; index += 1) {
      const run = cleaned[index] as Run;
      const previous = next[next.length - 1];
      const following = cleaned[index + 1];
      const duration = run.end - run.start;
      const fragment = duration < minNoteSeconds;
      const spike =
        (duration < SPIKE_SECONDS && highSpike(run, previous, following)) ||
        (duration < OCTAVE_SPIKE_SECONDS && octaveSpike(run, previous, following));
      if (fragment || spike) {
        changed = true;
        if (
          previous !== undefined &&
          following !== undefined &&
          previous.midi === following.midi &&
          following.start - previous.end <= duration + frameSeconds * 2.5
        ) {
          previous.end = Math.max(previous.end, following.end);
          previous.clarity += run.clarity + following.clarity;
          previous.frames += run.frames + following.frames;
          index += 1;
        }
        continue;
      }
      if (
        previous !== undefined &&
        previous.midi === run.midi &&
        run.start - previous.end <= gapSeconds
      ) {
        previous.end = Math.max(previous.end, run.end);
        previous.clarity += run.clarity;
        previous.frames += run.frames;
      } else {
        next.push({ ...run });
      }
    }
    cleaned = next;
    if (!changed) {
      break;
    }
  }

  return cleaned
    .filter(
      (run) => range === null || (run.midi >= range.lowMidi && run.midi <= range.highMidi),
    )
    .filter((run) => run.end - run.start >= minNoteSeconds)
    .map((run) => ({
      start: run.start,
      end: run.end,
      midi: clamp(run.midi, 0, 127),
      confidence: clamp(run.frames === 0 ? 0 : run.clarity / run.frames, 0, 1),
    }));
}

/**
 * A whole vocal stem into a guide melody.
 *
 * Audio never leaves the worker: the caller hands a copy over by transfer and
 * gets a note list back. Progress is reported on the same scale as the rest of
 * the extension, nought to one.
 */
export function analyseMelody(
  samples: Float32Array,
  sampleRate: number,
  options: MelodyOptions = {},
): PracticeNote[] {
  const analysisRate = positive(options.analysisRate, ANALYSIS_RATE);
  const frameSize = Math.max(
    64,
    Math.round(positive(options.frameSize, ANALYSIS_FRAME)),
  );
  const hopSize = Math.max(
    1,
    Math.min(frameSize, Math.round(positive(options.hopSize, ANALYSIS_HOP))),
  );
  const resampled = downsampleForPitch(samples, sampleRate, analysisRate);
  if (resampled.length < frameSize) {
    return [];
  }

  const frames: PitchFrame[] = [];
  const frame = new Float32Array(frameSize);
  let lastReport = 0;
  for (let start = 0; start < resampled.length; start += hopSize) {
    frame.fill(0);
    frame.set(resampled.subarray(start, Math.min(start + frameSize, resampled.length)));
    const reading = detectPitch(frame, analysisRate, {
      minHz: PITCH_MIN_HZ,
      maxHz: PITCH_MAX_HZ,
      minClarity: PITCH_CLARITY,
    });
    frames.push({ at: start / analysisRate, ...reading });
    const fraction = Math.min(1, (start + frameSize) / resampled.length);
    if (fraction - lastReport >= 0.02) {
      lastReport = fraction;
      options.onProgress?.(fraction);
    }
  }
  options.onProgress?.(1);
  return segmentNotes(frames, {
    frameSeconds: hopSize / analysisRate,
    minClarity: PITCH_CLARITY,
    range: options.range ?? null,
  });
}
