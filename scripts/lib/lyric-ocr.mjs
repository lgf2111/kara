/**
 * Turning per-frame OCR output into timed lines, without any I/O.
 *
 * The lyric OCR spike samples a video at a few frames a second and runs OCR on
 * every frame. Each frame is an independent guess, so the same sung line comes
 * back several times in a row, spelled slightly differently each time, with a
 * frame dropped here and there. These helpers do the arithmetic that turns that
 * stream into lines with a start and an end: drop what does not look like text,
 * group runs of frames that read the same, and close the small holes OCR leaves.
 *
 * Everything here is pure so it can be tested without a video, a model or a
 * temporary directory. Nothing in this file reads or writes files, and no
 * recognised text is ever logged: the caller decides where text goes.
 */

/** Defaults for every option these helpers take. */
export const DEFAULTS = {
  /** Seconds one sampled frame stands for, so 1 / fps. */
  frameSeconds: 0.5,
  /** Tesseract's mean confidence for a frame, 0 to 100. Below this it is dropped. */
  minConfidence: 55,
  /** Normalised text shorter than this is not a lyric line. */
  minChars: 3,
  /** Share of a frame's characters that must be letters or digits, not symbols. */
  minLetterRatio: 0.6,
  /** Similarity at which two frames count as the same line. 1 is identical. */
  similarityThreshold: 0.7,
  /** A hole no longer than this between two like lines is OCR missing frames. */
  maxGapSeconds: 0.75,
  /** A line this short is flicker rather than something sung. */
  minLineSeconds: 0.4,
};

/**
 * @typedef {typeof DEFAULTS} Options
 */

/**
 * @typedef {object} Box
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1
 * @property {number} y1
 */

/**
 * One frame's OCR result.
 *
 * @typedef {object} Frame
 * @property {number} seconds where the frame sits in the video
 * @property {string} text what OCR read, raw
 * @property {number} confidence mean confidence for the frame, 0 to 100
 */

/**
 * One line of lyrics, as read off the screen.
 *
 * @typedef {object} Line
 * @property {string} text the reading from the most confident frame
 * @property {number} startSeconds
 * @property {number} endSeconds
 * @property {number} frames how many frames agreed on it
 * @property {number} confidence mean confidence of those frames
 */

/**
 * @param {number} value
 * @param {number} [places]
 * @returns {number}
 */
function round(value, places = 3) {
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
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseText(raw) {
  return raw
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The form two readings are compared in: case and punctuation are the first
 * things OCR gets wrong, and neither changes which line is on screen.
 *
 * @param {string} text
 * @returns {string}
 */
export function comparisonKey(text) {
  return normaliseText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Levenshtein distance in characters, over two rows rather than a full matrix.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
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
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
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
 *
 * @param {Frame} frame
 * @param {Partial<Options>} [options]
 * @returns {boolean}
 */
export function keepFrame(frame, options = {}) {
  const { minConfidence, minChars, minLetterRatio } = { ...DEFAULTS, ...options };
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

/**
 * Groups runs of frames that read the same into lines.
 *
 * A line stays open while frames keep reading like it, and closes on the first
 * frame that reads differently or is not kept at all. Its text is taken from
 * the most confident frame in the run, and new frames are compared against that
 * same frame, so one bad reading in the middle cannot drag the line away from
 * what it started as.
 *
 * A line ends one frame after its last frame began, because that is all a
 * sampled frame tells you: the line was still up when the frame was taken.
 *
 * @param {readonly Frame[]} frames
 * @param {Partial<Options>} [options]
 * @returns {Line[]}
 */
export function groupFrames(frames, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const ordered = [...frames].sort((a, b) => a.seconds - b.seconds);

  /** @type {Line[]} */
  const lines = [];
  /** @type {{ key: string, text: string, best: number, total: number, frames: number, start: number, end: number } | null} */
  let open = null;

  const close = () => {
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
 *
 * @param {readonly Line[]} lines
 * @param {Partial<Options>} [options]
 * @returns {Line[]}
 */
export function mergeShortGaps(lines, options = {}) {
  const { maxGapSeconds, similarityThreshold } = { ...DEFAULTS, ...options };

  /** @type {Line[]} */
  const merged = [];
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
 *
 * @param {readonly Frame[]} frames
 * @param {Partial<Options>} [options]
 * @returns {Line[]}
 */
export function linesFromFrames(frames, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const lines = mergeShortGaps(groupFrames(frames, settings), settings);
  // A hair of tolerance: a duration of exactly one frame is built from two
  // floats and need not land on the threshold exactly.
  return lines.filter(
    (line) => line.endSeconds - line.startSeconds >= settings.minLineSeconds - 1e-9,
  );
}

/**
 * @typedef {object} DurationStats
 * @property {number} count
 * @property {number | null} medianSeconds
 * @property {number | null} minSeconds
 * @property {number | null} maxSeconds
 */

/**
 * How long the lines ran. Median rather than mean: one line left on screen
 * through an instrumental break would otherwise hide every real line.
 *
 * @param {readonly Line[]} lines
 * @returns {DurationStats}
 */
export function durationStats(lines) {
  const durations = lines
    .map((line) => line.endSeconds - line.startSeconds)
    .sort((a, b) => a - b);
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

/**
 * The smallest box holding all of them, ignoring any box with a coordinate that
 * is not a finite number.
 *
 * @param {readonly Box[]} boxes
 * @returns {Box | null}
 */
export function unionBox(boxes) {
  /** @type {Box | null} */
  let result = null;
  for (const box of boxes) {
    if (![box.x0, box.y0, box.x1, box.y1].every((value) => Number.isFinite(value))) {
      continue;
    }
    const next = {
      x0: Math.min(box.x0, box.x1),
      y0: Math.min(box.y0, box.y1),
      x1: Math.max(box.x0, box.x1),
      y1: Math.max(box.y0, box.y1),
    };
    result =
      result === null
        ? next
        : {
            x0: Math.min(result.x0, next.x0),
            y0: Math.min(result.y0, next.y0),
            x1: Math.max(result.x1, next.x1),
            y1: Math.max(result.y1, next.y1),
          };
  }
  return result;
}

/**
 * @typedef {object} Region
 * @property {number} left as a fraction of the frame width
 * @property {number} top as a fraction of the frame height
 * @property {number} right
 * @property {number} bottom
 * @property {number} coverage share of frames covering the busiest cell
 */

/**
 * A coarse guess at where the lyrics sit in the frame.
 *
 * The frame is cut into a grid, every box marks the cells it covers, and the
 * answer is the span of cells that hold text at least half as often as the
 * busiest one. Cells rather than an average of boxes: a single title card
 * across the top would pull an average up there, but it cannot outvote the
 * cells that hold a line in every frame.
 *
 * @param {readonly Box[]} boxes one per frame that had text, in pixels
 * @param {{ width: number, height: number, grid?: number }} frame
 * @returns {Region | null}
 */
export function dominantRegion(boxes, frame) {
  const { width, height } = frame;
  const grid = frame.grid ?? 10;
  if (boxes.length === 0 || !(width > 0) || !(height > 0) || grid < 1) {
    return null;
  }

  /**
   * @param {number} fraction
   * @returns {number}
   */
  const cell = (fraction) => Math.min(grid - 1, Math.max(0, Math.floor(fraction * grid)));

  const counts = Array.from({ length: grid * grid }, () => 0);
  for (const box of boxes) {
    if (![box.x0, box.y0, box.x1, box.y1].every((value) => Number.isFinite(value))) {
      continue;
    }
    const first = cell(Math.min(box.x0, box.x1) / width);
    const last = cell(Math.max(box.x0, box.x1) / width);
    const top = cell(Math.min(box.y0, box.y1) / height);
    const bottom = cell(Math.max(box.y0, box.y1) / height);
    for (let row = top; row <= bottom; row += 1) {
      for (let column = first; column <= last; column += 1) {
        const index = row * grid + column;
        counts[index] = (counts[index] ?? 0) + 1;
      }
    }
  }

  const hottest = Math.max(...counts);
  if (hottest === 0) {
    return null;
  }
  let minRow = grid;
  let maxRow = -1;
  let minColumn = grid;
  let maxColumn = -1;
  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) {
      if ((counts[row * grid + column] ?? 0) * 2 >= hottest) {
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
        minColumn = Math.min(minColumn, column);
        maxColumn = Math.max(maxColumn, column);
      }
    }
  }
  return {
    left: round(minColumn / grid),
    top: round(minRow / grid),
    right: round((maxColumn + 1) / grid),
    bottom: round((maxRow + 1) / grid),
    coverage: round(hottest / boxes.length),
  };
}

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Pixel size of a PNG, read from its header.
 *
 * The frame size is needed to say where in the frame the text sits, and the
 * first 24 bytes of a sampled frame already carry it. Cheaper than asking
 * ffprobe, and it is the size of the image OCR actually saw.
 *
 * @param {Uint8Array} bytes the first 24 bytes are enough
 * @returns {{ width: number, height: number } | null}
 */
export function pngSize(bytes) {
  if (bytes.length < 24) {
    return null;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return null;
    }
  }
  // IHDR is always the first chunk: 4 bytes of length, 4 of type, then the size.
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}
