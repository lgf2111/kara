import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DUET_CONFIG,
  DEFAULT_DUET_MIX,
  IDLE_DUET,
  duetGains,
  duetPercent,
  duetPhaseLabel,
  duetPhaseOf,
  normaliseDuetConfig,
  normaliseDuetMix,
  normaliseDuetStatus,
  withDuetLevel,
  withDuetMute,
  withDuetSolo,
} from '../src/audio/duet.ts';
import { isCommand } from '../src/protocol.ts';

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

  it('defaults the URL while keeping a token when only the token is stored', () => {
    expect(normaliseDuetConfig({ token: '  abc  ' })).toEqual({
      url: DEFAULT_DUET_CONFIG.url,
      token: 'abc',
    });
  });

  it('treats a non-string token as empty', () => {
    expect(normaliseDuetConfig({ url: 'http://localhost:9000', token: 42 })).toEqual({
      url: 'http://localhost:9000',
      token: '',
    });
  });
});

describe('the duet commands', () => {
  it('recognises a saved connection sent to the audio side', () => {
    expect(
      isCommand({
        type: 'duet-config',
        config: { url: 'http://127.0.0.1:8765', token: 'abc' },
      }),
    ).toBe(true);
  });

  it('recognises a start that carries the connection', () => {
    expect(
      isCommand({
        type: 'start',
        stream: {
          videoId: 'abcdefghijk',
          url: 'https://example.com/audio',
          mimeType: 'audio/webm',
        },
        tabId: 1,
        key: 0,
        duet: { url: 'http://127.0.0.1:8765', token: 'abc' },
      }),
    ).toBe(true);
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
  it('normalises a bridge phase', () => {
    expect(duetPhaseOf('mapping')).toBe('mapping');
    expect(duetPhaseOf('separating')).toBe('separating');
    expect(duetPhaseOf('calibrating')).toBe('calibrating');
    expect(duetPhaseOf('done')).toBe('starting');
    expect(duetPhaseOf(null)).toBe('starting');
  });

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

describe('normaliseDuetStatus', () => {
  it('keeps a ready cached pair ready and says where it came from', () => {
    const status = normaliseDuetStatus({
      state: 'ready',
      progress: { phase: 'calibrating', done: 2, total: 4 },
      detail: '  Loaded\nfrom cache.  ',
      mix: DEFAULT_DUET_MIX,
      hasVoices: true,
      lowConfidenceSeconds: 12.5,
      source: 'cache',
    });

    expect(status.state).toBe('ready');
    expect(status.source).toBe('cache');
    expect(status.progress).toEqual({ phase: 'calibrating', done: 2, total: 4 });
    expect(status.detail).toBe('Loaded from cache.');
    expect(status.hasVoices).toBe(true);
    expect(status.lowConfidenceSeconds).toBe(12.5);
  });

  it('drops an unknown state and source rather than trusting them', () => {
    expect(normaliseDuetStatus(null)).toEqual(IDLE_DUET);
    expect(
      normaliseDuetStatus({
        state: 'singing',
        progress: 'half',
        hasVoices: 'yes',
        lowConfidenceSeconds: -1,
        source: 'somewhere',
      }),
    ).toEqual({
      ...IDLE_DUET,
      hasVoices: false,
      lowConfidenceSeconds: null,
      source: null,
    });
  });
});
