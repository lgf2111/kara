import { describe, expect, it } from 'vitest';

import { SOURCES } from '../../web/src/separation/htdemucs.ts';
import {
  DEFAULT_MIX,
  isStem,
  mixGains,
  normaliseMix,
  railLanes,
  stemFromPercent,
  stemLevel,
  stemPercent,
  STEMS,
  withMute,
  withSolo,
  withStem,
} from '../src/audio/stems.ts';

/**
 * The mixer's values, which are the one thing both sides of the message
 * boundary have to agree on: the panel sends a level and two switches per
 * name, the engine resolves them to gains in `STEMS` order, and the worklet
 * reads that order against the model's.
 */
describe('the stem order', () => {
  it('is the model’s order, so a gain can never land on the wrong stem', () => {
    expect(STEMS).toEqual(SOURCES);
  });

  it('knows each of its own names and nothing else', () => {
    for (const stem of STEMS) {
      expect(isStem(stem)).toBe(true);
    }
    expect(isStem('piano')).toBe(false);
    expect(isStem(3)).toBe(false);
    expect(isStem(null)).toBe(false);
  });
});

describe('DEFAULT_MIX', () => {
  it('is karaoke: all sliders full, the vocal muted, nothing soloed', () => {
    expect(DEFAULT_MIX).toEqual({
      levels: { drums: 1, bass: 1, other: 1, vocals: 1 },
      muted: { drums: false, bass: false, other: false, vocals: true },
      soloed: { drums: false, bass: false, other: false, vocals: false },
    });
  });
});

describe('normaliseMix', () => {
  it('fills a missing stem from the default rather than changing the rest', () => {
    expect(normaliseMix({ levels: { bass: 0.5 } })).toEqual({
      ...DEFAULT_MIX,
      levels: { ...DEFAULT_MIX.levels, bass: 0.5 },
    });
  });

  it('still reads the flat level shape from before mute and solo existed', () => {
    expect(normaliseMix({ vocals: 0.5 })).toEqual({
      ...DEFAULT_MIX,
      levels: { ...DEFAULT_MIX.levels, vocals: 0.5 },
    });
  });

  it('reads nothing at all as the default', () => {
    expect(normaliseMix(null)).toEqual(DEFAULT_MIX);
    expect(normaliseMix('drums')).toEqual(DEFAULT_MIX);
    expect(normaliseMix([])).toEqual(DEFAULT_MIX);
  });

  it('clamps a readable level rather than replacing it', () => {
    expect(
      normaliseMix({ levels: { drums: -1, bass: 2, other: 0.25, vocals: 4 } }),
    ).toEqual({
      ...DEFAULT_MIX,
      levels: { drums: 0, bass: 1, other: 0.25, vocals: 1 },
    });
  });

  it('replaces a value that is not a number, one stem at a time', () => {
    expect(
      normaliseMix({
        levels: {
          drums: Number.NaN,
          bass: Number.POSITIVE_INFINITY,
          other: 'loud',
          vocals: 0.3,
        },
      }),
    ).toEqual({
      ...DEFAULT_MIX,
      levels: { ...DEFAULT_MIX.levels, vocals: 0.3 },
    });
  });

  it('honours an explicit boolean and falls back to the stem default otherwise', () => {
    expect(
      normaliseMix({ muted: { drums: true, bass: 1, other: 'yes', vocals: false } }).muted,
    ).toEqual({ drums: true, bass: false, other: false, vocals: false });
    expect(normaliseMix({ soloed: { vocals: true } }).soloed).toEqual({
      drums: false,
      bass: false,
      other: false,
      vocals: true,
    });
  });

  it('keeps the vocal muted when the switches are missing entirely', () => {
    const mix = normaliseMix({ levels: { vocals: 0.5 } });

    expect(mix.levels.vocals).toBe(0.5);
    expect(mix.muted.vocals).toBe(true);
    expect(normaliseMix({ muted: { vocals: false } }).muted.vocals).toBe(false);
  });
});

describe('stemLevel', () => {
  it('keeps a gain where adding the stems back up cannot clip', () => {
    expect(stemLevel(-1)).toBe(0);
    expect(stemLevel(0.5)).toBe(0.5);
    expect(stemLevel(4)).toBe(1);
  });

  it('treats anything unreadable as silence for that one stem', () => {
    expect(stemLevel(Number.NaN)).toBe(0);
    expect(stemLevel('1')).toBe(0);
    expect(stemLevel(null)).toBe(0);
  });
});

describe('withStem', () => {
  it('moves one stem and leaves the rest alone', () => {
    const mix = withStem(DEFAULT_MIX, 'bass', 0.25);

    expect(mix.levels).toEqual({ ...DEFAULT_MIX.levels, bass: 0.25 });
    expect(DEFAULT_MIX.levels.bass).toBe(1);
  });

  it('clamps the new level', () => {
    expect(withStem(DEFAULT_MIX, 'vocals', 9).levels.vocals).toBe(1);
    expect(withStem(DEFAULT_MIX, 'vocals', -9).levels.vocals).toBe(0);
  });

  it('does not disturb a mute or a solo', () => {
    const switched = withSolo(withMute(DEFAULT_MIX, 'drums', true), 'bass', true);
    const moved = withStem(switched, 'drums', 0.4);

    expect(moved.muted.drums).toBe(true);
    expect(moved.soloed.bass).toBe(true);
    expect(moved.levels.drums).toBe(0.4);
  });
});

describe('withMute and withSolo', () => {
  it('switch one stem without moving a slider or the other switch', () => {
    const muted = withMute(withStem(DEFAULT_MIX, 'other', 0.3), 'bass', true);
    const soloed = withSolo(muted, 'vocals', true);

    expect(muted.muted.bass).toBe(true);
    expect(muted.soloed.bass).toBe(false);
    expect(muted.levels.other).toBe(0.3);
    expect(soloed.soloed.vocals).toBe(true);
    expect(soloed.muted.bass).toBe(true);
    expect(soloed.levels.other).toBe(0.3);
  });

  it('treats anything but true as off, so a stray value makes sound rather than silence', () => {
    expect(withMute(DEFAULT_MIX, 'drums', 'yes').muted.drums).toBe(false);
    expect(withSolo(DEFAULT_MIX, 'drums', 1).soloed.drums).toBe(false);
  });
});

describe('mixGains', () => {
  it('is karaoke by default: the backing audible and the vocal muted', () => {
    expect(mixGains(DEFAULT_MIX)).toEqual([1, 1, 1, 0]);
  });

  it('is the four levels in the model’s order when no switch is pressed', () => {
    expect(
      mixGains({
        levels: { drums: 0.1, bass: 0.2, other: 0.3, vocals: 0.4 },
        muted: { drums: false, bass: false, other: false, vocals: false },
        soloed: { drums: false, bass: false, other: false, vocals: false },
      }),
    ).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('silences a muted stem without moving its slider', () => {
    const mix = withMute(withStem(DEFAULT_MIX, 'drums', 0.5), 'drums', true);

    expect(mix.levels.drums).toBe(0.5);
    expect(mixGains(mix)).toEqual([0, 1, 1, 0]);
  });

  it('narrows the desk to the soloed stems', () => {
    const mix = withSolo(DEFAULT_MIX, 'bass', true);

    expect(mixGains(mix)).toEqual([0, 1, 0, 0]);
  });

  it('keeps every soloed stem when more than one is soloed', () => {
    const mix = withMute(
      withStem(
        withSolo(withSolo(DEFAULT_MIX, 'drums', true), 'vocals', true),
        'vocals',
        0.4,
      ),
      'vocals',
      false,
    );

    expect(mixGains(mix)).toEqual([1, 0, 0, 0.4]);
  });

  it('lets mute win over solo, as a hardware desk does', () => {
    const mix = withSolo(withMute(DEFAULT_MIX, 'drums', true), 'drums', true);

    expect(mixGains(mix)).toEqual([0, 0, 0, 0]);
  });

  it('normalises what it is given, so the wire never carries a bad gain', () => {
    expect(mixGains({ levels: { drums: -1 } } as never)).toEqual([0, 1, 1, 0]);
  });
});

describe('percentage conversion', () => {
  it('round-trips a level through the slider', () => {
    expect(stemPercent(0.42)).toBe(42);
    expect(stemFromPercent(42)).toBeCloseTo(0.42);
  });

  it('clamps in both directions rather than passing nonsense on', () => {
    expect(stemPercent(-1)).toBe(0);
    expect(stemPercent(9)).toBe(100);
    expect(stemFromPercent(-5)).toBe(0);
    expect(stemFromPercent(500)).toBe(1);
    expect(stemPercent(Number.NaN)).toBe(0);
    expect(stemFromPercent(Number.NaN)).toBe(0);
  });
});

describe('railLanes', () => {
  it('draws vocals first, then the backing stems', () => {
    const lanes = railLanes(DEFAULT_MIX);

    expect(lanes.map((lane) => lane.stem)).toEqual(['vocals', 'other', 'bass', 'drums']);
  });

  it('reads each lane height from its level', () => {
    const lanes = railLanes(withStem(DEFAULT_MIX, 'drums', 0.25));

    expect(lanes.find((lane) => lane.stem === 'drums')?.percent).toBe(25);
    expect(lanes.find((lane) => lane.stem === 'vocals')?.percent).toBe(100);
  });

  it('marks the guide as muted on the default mix, because it is', () => {
    const lanes = railLanes(DEFAULT_MIX);

    expect(lanes.find((lane) => lane.stem === 'vocals')?.muted).toBe(true);
    expect(lanes.filter((lane) => lane.stem !== 'vocals').every((lane) => !lane.muted)).toBe(true);
  });

  it('dims every lane that is not soloed once one is', () => {
    const lanes = railLanes(withSolo(DEFAULT_MIX, 'bass', true));

    expect(lanes.find((lane) => lane.stem === 'bass')?.dimmed).toBe(false);
    expect(lanes.filter((lane) => lane.stem !== 'bass').every((lane) => lane.dimmed)).toBe(true);
  });

  it('dims nothing when no stem is soloed', () => {
    expect(railLanes(DEFAULT_MIX).some((lane) => lane.dimmed)).toBe(false);
  });
});
