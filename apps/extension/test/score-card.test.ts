import { describe, expect, it } from 'vitest';

import type { PracticeRun } from '../src/practice/history.ts';
import {
  SCORE_CARD_HEIGHT,
  SCORE_CARD_WIDTH,
  scoreCardFilename,
  scoreCardLayout,
  wrapScoreCardTitle,
} from '../src/practice/score-card.ts';

const RUN: PracticeRun = {
  videoId: 'abcdefghijk',
  title: 'Blue Moon',
  artist: 'The Marcels',
  singer: null,
  score: 87.4,
  accuracy: 92.2,
  notesHit: 18,
  notesTotal: 24,
  longestStreak: 11,
  at: Date.UTC(2026, 10, 6, 12),
};

function textOf(layout: ReturnType<typeof scoreCardLayout>, id: string): string | null {
  return layout.texts.find((entry) => entry.id === id)?.text ?? null;
}

describe('scoreCardLayout', () => {
  it('carries every number the score card promises', () => {
    const layout = scoreCardLayout(RUN);

    expect(layout.width).toBe(SCORE_CARD_WIDTH);
    expect(layout.height).toBe(SCORE_CARD_HEIGHT);
    expect(textOf(layout, 'mark')).toBe('Kara');
    expect(textOf(layout, 'title-0')).toBe('Blue Moon');
    expect(textOf(layout, 'artist')).toBe('The Marcels');
    expect(textOf(layout, 'score')).toBe('87');
    expect(textOf(layout, 'stat-value-0')).toBe('92%');
    expect(textOf(layout, 'stat-value-1')).toBe('18 / 24');
    expect(textOf(layout, 'stat-value-2')).toBe('11');
    expect(textOf(layout, 'date')).toBe('6 Nov 2026');
    expect(textOf(layout, 'singer')).toBeNull();
  });

  it('adds the singer only when there is one', () => {
    const withSinger = scoreCardLayout({ ...RUN, singer: 'Lee' });

    expect(textOf(withSinger, 'singer')).toBe('Sung by Lee');
  });

  it('keeps every word inside the card and inside its column', () => {
    const layout = scoreCardLayout(RUN);

    for (const entry of layout.texts) {
      expect(entry.x).toBeGreaterThanOrEqual(0);
      expect(entry.x).toBeLessThanOrEqual(layout.width);
      expect(entry.y).toBeGreaterThanOrEqual(0);
      expect(entry.y).toBeLessThanOrEqual(layout.height);
      expect(entry.maxWidth).toBeGreaterThan(0);
      expect(entry.size).toBeGreaterThan(0);
    }
    for (const rect of layout.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('wraps a long title to three lines with an ellipsis rather than spilling', () => {
    const layout = scoreCardLayout({
      ...RUN,
      title: 'A Very Long Song Title That Keeps Going And Going And Going Without Stopping Right Now Forever',
    });

    expect(layout.titleLines).toHaveLength(3);
    expect(layout.titleLines[2]).toContain('…');
    expect(layout.texts.filter((entry) => entry.id.startsWith('title-'))).toHaveLength(3);
  });
});

describe('wrapScoreCardTitle', () => {
  it('wraps whole words and leaves a short title alone', () => {
    expect(wrapScoreCardTitle('Blue Moon')).toEqual(['Blue Moon']);
    expect(wrapScoreCardTitle('One Two Three Four Five', 10)).toEqual([
      'One Two',
      'Three Four',
      'Five',
    ]);
  });

  it('has words for an empty title and clips a word that is too long', () => {
    expect(wrapScoreCardTitle('   ')).toEqual(['Untitled song']);
    expect(wrapScoreCardTitle('abcdefghijklmnop', 6)[0]).toBe('abcde…');
  });
});

describe('scoreCardFilename', () => {
  it('names the song, its score and its date', () => {
    expect(scoreCardFilename(RUN)).toBe('kara-blue-moon-87-2026-11-06.png');
    expect(scoreCardFilename({ ...RUN, title: '!!!' })).toBe('kara-score-87-2026-11-06.png');
  });
});
