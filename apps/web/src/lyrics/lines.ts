import type { LyricLine } from '../library/songs.ts';

/**
 * Turning per-frame OCR output into timed lines, without any I/O.
 *
 * The reader samples a video a couple of times a second and runs OCR on every
 * frame. Each frame is an independent guess, so the same sung line comes back
 * several times in a row, spelled slightly differently each time, with a frame
 * dropped here and there. These helpers do the arithmetic that turns that
 * stream into lines with a start and an end: drop what does not look like
 * text, group runs of frames that read the same, and close the small holes OCR
 * leaves.
 *
 * A port of `scripts/lib/lyric-ocr.mjs`, which is the node spike that measured
 * the method on a real lyric video. The node copy stays as it is, because it is
 * the record of that measurement; keep the two in step when either changes.
 *
 * Everything here is pure, so it is tested without a video or a model. No
 * recognised text is ever logged: the caller decides where text goes.
 */

export interface GroupingOptions {
  /** Seconds one sampled frame stands for, so 1 / fps. */
  readonly frameSeconds: number;
  /** Tesseract's mean confidence for a frame, 0 to 100. Below this it is dropped. */
  readonly minConfidence: number;
  /** Normalised text shorter than this is not a lyric line. */
  readonly minChars: number;
  /** Share of a frame's characters that must be letters or digits, not symbols. */
  readonly minLetterRatio: number;
  /** Similarity at which two frames count as the same line. 1 is identical. */
  readonly similarityThreshold: number;
  /** A hole no longer than this between two like lines is OCR missing frames. */
  readonly maxGapSeconds: number;
  /** A line this short is flicker rather than something sung. */
  readonly minLineSeconds: number;
}

/** The thresholds the node spike measured its 86% coverage with. */
export const GROUPING: GroupingOptions = {
  frameSeconds: 0.5,
  minConfidence: 55,
  minChars: 3,
  minLetterRatio: 0.6,
  similarityThreshold: 0.7,
  maxGapSeconds: 0.75,
  minLineSeconds: 0.4,
};

/** One frame's OCR result. */
export interface OcrFrame {
  /** Where the frame sits in the video. */
  readonly seconds: number;
  /** What OCR read, raw. */
  readonly text: string;
  /** Mean confidence for the frame, 0 to 100. */
  readonly confidence: number;
}

/** One line of lyrics, as read off the screen. */
export interface GroupedLine {
  /** The reading from the most confident frame. */
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** How many frames agreed on it. */
  readonly frames: number;
  readonly confidence: number;
}

function round(value: number, places = 3): number {
  const scale = 10 ** places;
  // Adding 0 turns a -0 back into 0, which reads better in JSON.
  return Math.round(value * scale) / scale + 0;
}

/**
 * Collapses OCR whitespace so two readings of one line can be compared.
 *
 * OCR returns line and page breaks wherever it thinks it saw them, plus the
 * occasional zero-width or control character. None of that is part of the
 * lyric, and all of it would otherwise count as a difference.
 */
export function normaliseText(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The form two readings are compared in: case and punctuation are the first
 * things OCR gets wrong, and neither changes which line is on screen.
 */
export function comparisonKey(text: string): string {
  return normaliseText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Levenshtein distance in characters, over two rows rather than a full matrix. */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  let current = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const same = left[i - 1] === right[j - 1];
      current[j] = Math.min(
        (previous[j - 1] ?? 0) + (same ? 0 : 1),
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length] ?? 0;
}

/**
 * 1 for identical strings, 0 for nothing in common. Two empty strings are
 * identical, which keeps a run of blank frames from splitting into many lines.
 */
export function similarity(a: string, b: string): number {
  const longest = Math.max([...a].length, [...b].length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

/**
 * Whether a frame's reading is worth keeping.
 *
 * Two things are thrown away: readings OCR itself is unsure of, and readings
 * that are mostly not letters. The second catches what OCR makes of a busy
 * background or a watermark, which arrives as a confident handful of bars and
 * dots.
 */
export function keepFrame(frame: OcrFrame, options: Partial<GroupingOptions> = {}): boolean {
  const { minConfidence, minChars, minLetterRatio } = { ...GROUPING, ...options };
  if (!Number.isFinite(frame.confidence) || frame.confidence < minConfidence) {
    return false;
  }
  const text = normaliseText(frame.text);
  if (text.length < minChars) {
    return false;
  }
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return letters / text.length >= minLetterRatio;
}

interface OpenLine {
  key: string;
  text: string;
  best: number;
  total: number;
  frames: number;
  start: number;
  end: number;
}

/**
 * Groups runs of frames that read the same into lines.
 *
 * A line stays open while frames keep reading like it, and closes on the first
 * frame that reads differently or is not kept at all. Its text is taken from
 * the most confident frame in the run, and new frames are compared against
 * that same frame, so one bad reading in the middle cannot drag the line away
 * from what it started as.
 *
 * A line ends one frame after its last frame began, because that is all a
 * sampled frame tells you: the line was still up when the frame was taken.
 */
export function groupFrames(
  frames: readonly OcrFrame[],
  options: Partial<GroupingOptions> = {},
): GroupedLine[] {
  const settings = { ...GROUPING, ...options };
  const ordered = [...frames].sort((a, b) => a.seconds - b.seconds);

  const lines: GroupedLine[] = [];
  let open: OpenLine | null = null;

  const close = (): void => {
    if (open !== null) {
      lines.push({
        text: open.text,
        startSeconds: round(open.start),
        endSeconds: round(open.end),
        frames: open.frames,
        confidence: round(open.total / open.frames, 1),
      });
      open = null;
    }
  };

  for (const frame of ordered) {
    if (!keepFrame(frame, settings)) {
      close();
      continue;
    }
    const key = comparisonKey(frame.text);
    const end = frame.seconds + settings.frameSeconds;
    if (open === null || similarity(open.key, key) < settings.similarityThreshold) {
      close();
      open = {
        key,
        text: normaliseText(frame.text),
        best: frame.confidence,
        total: frame.confidence,
        frames: 1,
        start: frame.seconds,
        end,
      };
      continue;
    }
    open.frames += 1;
    open.total += frame.confidence;
    open.end = end;
    if (frame.confidence > open.best) {
      open.best = frame.confidence;
      open.text = normaliseText(frame.text);
      open.key = key;
    }
  }
  close();
  return lines;
}

/**
 * Joins neighbouring lines that read alike and are only a moment apart.
 *
 * OCR loses a frame to a camera cut, a flash or a fade, which splits one sung
 * line into two. The hole is short and both sides read the same, so they are
 * one line.
 */
export function mergeShortGaps(
  lines: readonly GroupedLine[],
  options: Partial<GroupingOptions> = {},
): GroupedLine[] {
  const { maxGapSeconds, similarityThreshold } = { ...GROUPING, ...options };

  const merged: GroupedLine[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    const gap = previous === undefined ? Infinity : line.startSeconds - previous.endSeconds;
    const alike =
      previous !== undefined &&
      similarity(comparisonKey(previous.text), comparisonKey(line.text)) >= similarityThreshold;
    if (previous === undefined || gap > maxGapSeconds || !alike) {
      merged.push(line);
      continue;
    }
    const frames = previous.frames + line.frames;
    merged[merged.length - 1] = {
      text: previous.confidence >= line.confidence ? previous.text : line.text,
      startSeconds: previous.startSeconds,
      endSeconds: Math.max(previous.endSeconds, line.endSeconds),
      frames,
      confidence: round(
        (previous.confidence * previous.frames + line.confidence * line.frames) / frames,
        1,
      ),
    };
  }
  return merged;
}

/**
 * Every step at once: drop, group, close the holes, then drop what is left too
 * short to have been sung.
 */
export function linesFromFrames(
  frames: readonly OcrFrame[],
  options: Partial<GroupingOptions> = {},
): GroupedLine[] {
  const settings = { ...GROUPING, ...options };
  const lines = mergeShortGaps(groupFrames(frames, settings), settings);
  // A hair of tolerance: a duration of exactly one frame is built from two
  // floats and need not land on the threshold exactly.
  return lines.filter(
    (line) => line.endSeconds - line.startSeconds >= settings.minLineSeconds - 1e-9,
  );
}

export interface DurationStats {
  readonly count: number;
  readonly medianSeconds: number | null;
  readonly minSeconds: number | null;
  readonly maxSeconds: number | null;
}

/**
 * How long the lines ran. Median rather than mean: one line left on screen
 * through an instrumental break would otherwise hide every real line.
 */
export function durationStats(lines: readonly GroupedLine[]): DurationStats {
  const durations = lines.map((line) => line.endSeconds - line.startSeconds).sort((a, b) => a - b);
  if (durations.length === 0) {
    return { count: 0, medianSeconds: null, minSeconds: null, maxSeconds: null };
  }
  const middle = Math.floor(durations.length / 2);
  const median =
    durations.length % 2 === 1
      ? (durations[middle] ?? 0)
      : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2;
  return {
    count: durations.length,
    medianSeconds: round(median),
    minSeconds: round(durations[0] ?? 0),
    maxSeconds: round(durations[durations.length - 1] ?? 0),
  };
}

/** The shape the song record keeps: whole milliseconds and the text, nothing else. */
export function toLyricLines(lines: readonly GroupedLine[]): LyricLine[] {
  return lines.map((line) => ({
    startMs: Math.round(line.startSeconds * 1000),
    endMs: Math.round(line.endSeconds * 1000),
    text: line.text,
  }));
}
