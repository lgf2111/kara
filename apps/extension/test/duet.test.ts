import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DUET_CONFIG,
  DEFAULT_DUET_MIX,
  duetGains,
  duetPercent,
  duetPhaseLabel,
  normaliseDuetConfig,
  normaliseDuetMix,
  withDuetLevel,
  withDuetMute,
  withDuetSolo,
} from '../src/audio/duet.ts';

describe('normaliseDuetConfig', () => {
  it('uses the loopback default and an empty token when nothing is stored', () => {
    expect(normaliseDuetConfig(undefined)).toEqual(DEFAULT_DUET_CONFIG);
    expect(normaliseDuetConfig(null)).toEqual(DEFAULT_DUET_CONFIG);
    expect(normaliseDuetConfig('nonsense')).toEqual(DEFAULT_DUET_CONFIG);
  });

  it('removes trailing slashes and trims the token', () => {
    expect(normaliseDuetConfig({ url: 'http://127.0.0.1:8765///', token: '  abc  ' })).toEqual({
      url: 'http://127.0.0.1:8765',
      token: 'abc',
    });
  });

  it('rejects a URL without a scheme rather than inventing one', () => {
    expect(normaliseDuetConfig({ url: '127.0.0.1:8765' }).url).toBe(
      DEFAULT_DUET_CONFIG.url,
    );
  });
});

describe('the duet desk', () => {
  it('starts with both voices full and audible', () => {
    expect(DEFAULT_DUET_MIX).toEqual({
      levels: [1, 1],
      muted: [false, false],
      soloed: [false, false],
    });
    expect(duetGains(DEFAULT_DUET_MIX)).toEqual([1, 1]);
  });

  it('fills and clamps one voice at a time', () => {
    expect(normaliseDuetMix({ levels: [2] })).toEqual({
      ...DEFAULT_DUET_MIX,
      levels: [1, 1],
    });
    const quiet = withDuetLevel(DEFAULT_DUET_MIX, 0, -1);
    expect(quiet.levels).toEqual([0, 1]);
  });

  it('lets mute win over solo, as the hardware desk does', () => {
    const mix = withDuetSolo(withDuetMute(DEFAULT_DUET_MIX, 0, true), 0, true);
    expect(duetGains(mix)).toEqual([0, 0]);
  });

  it('silences the other voice when one is soloed', () => {
    expect(duetGains(withDuetSolo(DEFAULT_DUET_MIX, 1, true))).toEqual([0, 1]);
  });

  it('keeps the slider position when only the switch moves', () => {
    const mix = withDuetLevel(DEFAULT_DUET_MIX, 0, 0.4);
    expect(withDuetMute(mix, 0, true).levels[0]).toBe(0.4);
  });
});

describe('the duet words', () => {
  it('names every stage', () => {
    expect(duetPhaseLabel('separating')).toBe('Splitting the two voices');
    expect(duetPhaseLabel('mapping')).toBe('Mapping who sings when');
    expect(duetPhaseLabel('calibrating')).toBe('Learning this line');
    expect(duetPhaseLabel(null)).toBe('Splitting the two voices');
  });

  it('rounds a gain to a percentage and clamps it', () => {
    expect(duetPercent(0.456)).toBe(46);
    expect(duetPercent(-1)).toBe(0);
    expect(duetPercent(2)).toBe(100);
  });
});
