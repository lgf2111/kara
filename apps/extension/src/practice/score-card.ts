import { formatRunDate, type PracticeRun } from './history.ts';

/**
 * The score card, as geometry and words.
 *
 * A share card is a PNG, but almost none of it should be tested through a
 * canvas: the title wrapping, the numbers, the date and the positions are all
 * arithmetic, and this file is that arithmetic. `score-card-canvas.ts` only
 * turns the result into pixels. That keeps the card testable without a DOM and
 * keeps the drawing code to fills and `fillText`.
 *
 * The card is 1080 × 1350, the portrait size a phone shares without cropping,
 * and it carries only what the run produced: the song, the score, the accuracy,
 * the notes, the streak, the date and the Kara mark. The optional singer line
 * appears only when somebody put a name in.
 */

export const SCORE_CARD_WIDTH = 1080;
export const SCORE_CARD_HEIGHT = 1350;

export const SCORE_CARD_PALETTE = {
  ground: '#1b1116',
  panel: '#24171d',
  border: '#3b2a30',
  text: '#f7efe6',
  muted: '#c3b0a6',
  faint: '#9a877e',
  accent: '#e8b86d',
} as const;

export interface ScoreCardText {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly weight: number;
  readonly family: 'serif' | 'sans';
  readonly color: string;
  readonly align: 'left' | 'center' | 'right';
  readonly maxWidth: number;
}

export interface ScoreCardRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly fill: string | null;
  readonly stroke: string | null;
}

export interface ScoreCardLine {
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
  readonly width: number;
  readonly color: string;
}

export interface ScoreCardGlow {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly color: string;
}

export interface ScoreCardLayout {
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly glow: ScoreCardGlow;
  readonly rects: readonly ScoreCardRect[];
  readonly lines: readonly ScoreCardLine[];
  readonly texts: readonly ScoreCardText[];
  /** The wrapped title, kept separately so a test can read it without ids. */
  readonly titleLines: readonly string[];
}

/** A title wrapped to whole words, at most three lines, with an ellipsis. */
export function wrapScoreCardTitle(
  title: string,
  maxChars = 26,
  maxLines = 3,
): string[] {
  const words = title.replace(/\s+/gu, ' ').trim().split(' ').filter((word) => word !== '');
  if (words.length === 0) {
    return ['Untitled song'];
  }
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const clean = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    const candidate = line === '' ? clean : `${line} ${clean}`;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line !== '') {
      lines.push(line);
    }
    line = clean;
  }
  if (line !== '') {
    lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1] ?? '';
    kept[maxLines - 1] = `${last.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
    return kept;
  }
  return lines;
}

function text(
  id: string,
  value: string,
  x: number,
  y: number,
  size: number,
  weight: number,
  family: ScoreCardText['family'],
  color: string,
  align: ScoreCardText['align'],
  maxWidth: number,
): ScoreCardText {
  return { id, text: value, x, y, size, weight, family, color, align, maxWidth };
}

/** One run into the whole card: words, positions and the few rules between. */
export function scoreCardLayout(run: PracticeRun): ScoreCardLayout {
  const palette = SCORE_CARD_PALETTE;
  const titleLines = wrapScoreCardTitle(run.title);
  const texts: ScoreCardText[] = [];

  texts.push(
    text('mark', 'Kara', 104, 132, 46, 700, 'serif', palette.accent, 'left', 400),
    text(
      'subtitle',
      'PITCH PRACTICE',
      976,
      126,
      20,
      650,
      'sans',
      palette.faint,
      'right',
      400,
    ),
  );

  const titleTop = 262;
  const titleLineHeight = 74;
  titleLines.forEach((line, index) => {
    texts.push(
      text(
        `title-${String(index)}`,
        line,
        104,
        titleTop + index * titleLineHeight,
        62,
        700,
        'serif',
        palette.text,
        'left',
        872,
      ),
    );
  });

  let cursor = titleTop + titleLines.length * titleLineHeight + 8;
  if (run.artist !== null) {
    texts.push(
      text('artist', run.artist, 104, cursor, 30, 500, 'sans', palette.muted, 'left', 872),
    );
    cursor += 42;
  }
  if (run.singer !== null) {
    texts.push(
      text(
        'singer',
        `Sung by ${run.singer}`,
        104,
        cursor,
        24,
        500,
        'sans',
        palette.faint,
        'left',
        872,
      ),
    );
  }

  texts.push(
    text('score-label', 'SCORE', 540, 646, 20, 650, 'sans', palette.faint, 'center', 400),
    text(
      'score',
      String(Math.round(run.score)),
      540,
      884,
      240,
      700,
      'serif',
      palette.accent,
      'center',
      880,
    ),
  );

  const stats: readonly { readonly label: string; readonly value: string; readonly x: number }[] = [
    { label: 'ACCURACY', value: `${String(Math.round(run.accuracy))}%`, x: 250 },
    {
      label: 'NOTES HIT',
      value: `${String(run.notesHit)} / ${String(run.notesTotal)}`,
      x: 540,
    },
    { label: 'LONGEST STREAK', value: String(run.longestStreak), x: 830 },
  ];
  for (const [index, stat] of stats.entries()) {
    texts.push(
      text(
        `stat-label-${String(index)}`,
        stat.label,
        stat.x,
        992,
        17,
        650,
        'sans',
        palette.faint,
        'center',
        280,
      ),
      text(
        `stat-value-${String(index)}`,
        stat.value,
        stat.x,
        1048,
        44,
        650,
        'sans',
        palette.text,
        'center',
        280,
      ),
    );
  }

  texts.push(
    text('date', formatRunDate(run.at), 104, 1168, 26, 500, 'sans', palette.muted, 'left', 500),
    text('footer', 'Made on this device', 976, 1168, 22, 500, 'sans', palette.faint, 'right', 500),
    text(
      'note',
      'Your singing never left this device',
      540,
      1238,
      20,
      500,
      'sans',
      palette.faint,
      'center',
      700,
    ),
  );

  return {
    width: SCORE_CARD_WIDTH,
    height: SCORE_CARD_HEIGHT,
    background: palette.ground,
    glow: { x: 540, y: 260, radius: 650, color: 'rgba(232, 184, 109, 0.14)' },
    rects: [
      {
        x: 56,
        y: 56,
        width: 968,
        height: 1238,
        radius: 36,
        fill: palette.panel,
        stroke: palette.border,
      },
    ],
    lines: [
      { x1: 104, x2: 976, y: 166, width: 1, color: palette.border },
      { x1: 104, x2: 976, y: 1102, width: 1, color: palette.border },
    ],
    texts,
    titleLines,
  };
}

/** A file name that survives a download folder and still names the song. */
export function scoreCardFilename(run: PracticeRun): string {
  const slug = run.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  const date = new Date(run.at);
  const stamp = Number.isFinite(run.at) && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : 'unknown';
  return `kara-${slug === '' ? 'score' : slug}-${String(Math.round(run.score))}-${stamp}.png`;
}
