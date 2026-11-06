import { describe, expect, it } from 'vitest';

import {
  canFollowTempo,
  pitchOffsetForRate,
  pitchSemitonesForKey,
  TEMPO_MAX_RATE,
  TEMPO_MIN_RATE,
} from '../src/audio/tempo.ts';

describe('pitchOffsetForRate', () => {
  it('leaves the pitch alone at the recording speed', () => {
    expect(pitchOffsetForRate(1)).toBe(0);
  });

  it('goes down an octave when the stems read an octave faster', () => {
    expect(pitchOffsetForRate(2)).toBeCloseTo(-12);
  });

  it('goes up an octave when they read an octave slower', () => {
    expect(pitchOffsetForRate(0.5)).toBeCloseTo(12);
  });

  it.each([0.25, 0.75, 1.25, 1.5, 1.75])('cancels the transposition at %s×', (rate) => {
    // Reading at R multiplies the frequency by R. The shifter's ratio is
    // 2 ** (semitones / 12), so the two together must come back to one.
    expect(rate * 2 ** (pitchOffsetForRate(rate) / 12)).toBeCloseTo(1, 12);
  });

  it('has no ratio to cancel for a rate that is not a rate', () => {
    expect(pitchOffsetForRate(0)).toBe(0);
    expect(pitchOffsetForRate(-1)).toBe(0);
    expect(pitchOffsetForRate(Number.NaN)).toBe(0);
    expect(pitchOffsetForRate(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('pitchSemitonesForKey', () => {
  it('is exactly the chosen key at the recording speed', () => {
    expect(pitchSemitonesForKey(-6, 1)).toBe(-6);
    expect(pitchSemitonesForKey(0, 1)).toBe(0);
    expect(pitchSemitonesForKey(3, 1)).toBe(3);
  });

  it('adds the key to the speed compensation rather than replacing it', () => {
    // Faster reading raises pitch, so the shifter compensates downwards and
    // the person's key moves the result from there.
    expect(pitchSemitonesForKey(2, 2)).toBeCloseTo(-10);
    expect(pitchSemitonesForKey(-1, 0.5)).toBeCloseTo(11);
  });

  it('leaves the key alone in the output: rate × speed × key is the key', () => {
    for (const key of [-6, -2, 0, 4, 6]) {
      for (const rate of [0.5, 0.75, 1, 1.25, 1.5]) {
        const shifted = 2 ** (pitchSemitonesForKey(key, rate) / 12) * rate;
        expect(shifted).toBeCloseTo(2 ** (key / 12), 12);
      }
    }
  });
});

describe('canFollowTempo', () => {
  it('accepts every speed YouTube offers between 0.25× and 2×', () => {
    for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      expect(canFollowTempo(rate)).toBe(true);
    }
  });

  it('refuses a speed the player cannot read, so the video keeps its own sound', () => {
    expect(canFollowTempo(TEMPO_MIN_RATE - 0.01)).toBe(false);
    expect(canFollowTempo(TEMPO_MAX_RATE + 0.01)).toBe(false);
    expect(canFollowTempo(0)).toBe(false);
    expect(canFollowTempo(-1)).toBe(false);
    expect(canFollowTempo(Number.NaN)).toBe(false);
    expect(canFollowTempo(Number.POSITIVE_INFINITY)).toBe(false);
    expect(canFollowTempo('1.5')).toBe(false);
  });
});
