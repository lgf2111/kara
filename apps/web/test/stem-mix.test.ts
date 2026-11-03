import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VOCAL_CHOICE,
  STEM_SAMPLE_RATE,
  driftAction,
  frameCount,
  guideGain,
  spreadChannels,
  stemGains,
  stemPosition,
  stemSampleRate,
  vocalsUnavailableNote,
  type VocalChoice,
} from '../src/player/stem-mix.ts';

/** Counting numbers, so a channel that ends up with the wrong ones shows it. */
function interleaved(frames: number): Float32Array {
  return Float32Array.from({ length: frames * 2 }, (_unused, index) => index);
}

describe('frameCount', () => {
  it('counts stereo float32 frames', () => {
    expect(frameCount(0)).toBe(0);
    expect(frameCount(8)).toBe(1);
    expect(frameCount(800)).toBe(100);
  });

  it('ignores a tail of bytes that is not a whole frame', () => {
    expect(frameCount(805)).toBe(100);
    expect(frameCount(7)).toBe(0);
  });

  it('reads a missing file as nothing rather than throwing', () => {
    expect(frameCount(Number.NaN)).toBe(0);
    expect(frameCount(-8)).toBe(0);
  });
});

describe('spreadChannels', () => {
  it('splits interleaved frames into one array per channel', () => {
    const left = new Float32Array(3);
    const right = new Float32Array(3);

    expect(spreadChannels(interleaved(3), [left, right], 3)).toBe(3);

    // Channel 0 is the left, as the worker writes it: at = frame * 2 + channel.
    expect([...left]).toEqual([0, 2, 4]);
    expect([...right]).toEqual([1, 3, 5]);
  });

  it('writes only the frames asked for, leaving the rest of the scratch alone', () => {
    const left = new Float32Array(4).fill(-1);
    const right = new Float32Array(4).fill(-1);

    expect(spreadChannels(interleaved(4), [left, right], 2)).toBe(2);

    expect([...left]).toEqual([0, 2, -1, -1]);
    expect([...right]).toEqual([1, 3, -1, -1]);
  });

  it('stops at the shortest of what it was given', () => {
    const left = new Float32Array(2);
    const right = new Float32Array(2);

    // Four frames of data, room for two.
    expect(spreadChannels(interleaved(4), [left, right], 4)).toBe(2);
    expect([...left]).toEqual([0, 2]);

    // Room for two, one and a half frames of data.
    const short = new Float32Array([9, 8, 7]);
    expect(spreadChannels(short, [new Float32Array(2), new Float32Array(2)], 2)).toBe(1);
  });

  it('writes nothing when there is nothing to write', () => {
    expect(spreadChannels(interleaved(2), [], 2)).toBe(0);
    expect(spreadChannels(new Float32Array(0), [new Float32Array(2)], 2)).toBe(0);
    expect(spreadChannels(interleaved(2), [new Float32Array(2)], 0)).toBe(0);
    expect(spreadChannels(interleaved(2), [new Float32Array(2)], Number.NaN)).toBe(0);
  });
});

describe('stemSampleRate', () => {
  it('takes the rate the job was written at', () => {
    expect(stemSampleRate({ source: { sampleRate: 48000 } })).toBe(48000);
  });

  it('falls back to the decoder rate when the state says nothing usable', () => {
    expect(stemSampleRate(null)).toBe(STEM_SAMPLE_RATE);
    expect(stemSampleRate({})).toBe(STEM_SAMPLE_RATE);
    expect(stemSampleRate({ source: {} })).toBe(STEM_SAMPLE_RATE);
    expect(stemSampleRate({ source: { sampleRate: '44100' } })).toBe(STEM_SAMPLE_RATE);
    expect(stemSampleRate({ source: { sampleRate: 0 } })).toBe(STEM_SAMPLE_RATE);
    expect(stemSampleRate({ source: { sampleRate: 10 ** 9 } })).toBe(STEM_SAMPLE_RATE);
  });
});

describe('guideGain', () => {
  it('maps the fader onto an amplitude', () => {
    expect(guideGain(0)).toBe(0);
    expect(guideGain(50)).toBe(0.5);
    expect(guideGain(100)).toBe(1);
  });

  it('stays inside what a gain node should be handed', () => {
    expect(guideGain(140)).toBe(1);
    expect(guideGain(-20)).toBe(0);
    expect(guideGain(Number.NaN)).toBe(0);
  });
});

describe('stemGains', () => {
  const instrumental = (guidePercent: number): VocalChoice => ({ mode: 'instrumental', guidePercent });

  it('leaves the stems silent in original mode, whatever the fader says', () => {
    expect(stemGains({ mode: 'original', guidePercent: 80 }, 1, false)).toEqual({
      instrumental: 0,
      vocals: 0,
    });
  });

  it('plays the backing alone by default', () => {
    expect(stemGains(DEFAULT_VOCAL_CHOICE, 1, false)).toEqual({ instrumental: 1, vocals: 0 });
  });

  it('brings the voice back at the level asked for', () => {
    expect(stemGains(instrumental(40), 1, false)).toEqual({ instrumental: 1, vocals: 0.4 });
  });

  it('takes the player volume with it, on both stems', () => {
    expect(stemGains(instrumental(50), 0.5, false)).toEqual({ instrumental: 0.5, vocals: 0.25 });
  });

  it('is silent when the player is muted or turned down', () => {
    expect(stemGains(instrumental(100), 1, true)).toEqual({ instrumental: 0, vocals: 0 });
    expect(stemGains(instrumental(100), 0, false)).toEqual({ instrumental: 0, vocals: 0 });
  });

  it('survives a volume no element would accept', () => {
    expect(stemGains(instrumental(0), 4, false)).toEqual({ instrumental: 1, vocals: 0 });
    expect(stemGains(instrumental(0), Number.NaN, false)).toEqual({ instrumental: 0, vocals: 0 });
  });
});

describe('stemPosition', () => {
  const anchor = { contextSeconds: 10, mediaSeconds: 30, rate: 1 };

  it('counts forward from where the stems were started', () => {
    expect(stemPosition(anchor, 10)).toBe(30);
    expect(stemPosition(anchor, 12.5)).toBe(32.5);
  });

  it('moves with the playback rate', () => {
    expect(stemPosition({ ...anchor, rate: 2 }, 12)).toBe(34);
  });

  it('does not run backwards if the clock is read early', () => {
    expect(stemPosition(anchor, 9)).toBe(30);
  });
});

describe('driftAction', () => {
  it('holds while the two clocks agree', () => {
    expect(driftAction(30, 30)).toBe('hold');
    expect(driftAction(30, 30.05)).toBe('hold');
    expect(driftAction(30, 29.95)).toBe('hold');
  });

  it('resyncs once they are further apart than an ear would let pass', () => {
    expect(driftAction(30, 30.2)).toBe('resync');
    expect(driftAction(30, 29.8)).toBe('resync');
  });

  it('takes the tolerance it is given', () => {
    expect(driftAction(30, 30.05, 0.01)).toBe('resync');
    expect(driftAction(30, 30.5, 1)).toBe('hold');
  });

  it('leaves a time that is not there yet alone', () => {
    expect(driftAction(Number.NaN, 30)).toBe('hold');
    expect(driftAction(30, Number.NaN)).toBe('hold');
  });
});

describe('vocalsUnavailableNote', () => {
  it('says nothing for a song whose stems are there', () => {
    expect(vocalsUnavailableNote('ready')).toBeNull();
  });

  it('explains what is missing without blaming the player', () => {
    for (const status of ['separating', 'cancelled', 'failed'] as const) {
      expect(vocalsUnavailableNote(status)).toMatch(/finish separating/u);
    }
  });
});
