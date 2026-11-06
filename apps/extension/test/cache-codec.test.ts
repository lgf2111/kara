import { describe, expect, it } from 'vitest';

import {
  OPUS_BITRATE,
  createOpusStemCodec,
  resampleChannel,
} from '../src/cache/codec.ts';
import { CACHE_ENTRY_LIMIT_BYTES } from '../src/cache/entry.ts';

describe('resampleChannel', () => {
  it('returns exactly the requested frame count and copies at the same rate', () => {
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const same = resampleChannel(input, 48000, 48000, 5);
    expect([...same]).toEqual([...input]);
    expect(resampleChannel(input, 48000, 48000, 3).length).toBe(3);
    expect(resampleChannel(input, 48000, 48000, 8).length).toBe(8);
    expect(resampleChannel(input, 48000, 48000, 8)[6]).toBe(0);
  });

  it('keeps a 1 kHz tone at its level through 44.1 and 48 kHz', () => {
    const rate = 44100;
    const frames = rate * 2;
    const input = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      input[index] = 0.4 * Math.sin(2 * Math.PI * 1000 * (index / rate));
    }

    const up = resampleChannel(input, rate, 48000, Math.ceil(frames * (48000 / rate)));
    const back = resampleChannel(up, 48000, rate, frames);

    let expected = 0;
    let actual = 0;
    for (let index = 1000; index < frames - 1000; index += 1) {
      expected += (input[index] ?? 0) ** 2;
      actual += (back[index] ?? 0) ** 2;
    }
    const expectedRms = Math.sqrt(expected / (frames - 2000));
    const actualRms = Math.sqrt(actual / (frames - 2000));
    expect(actualRms).toBeGreaterThan(expectedRms * 0.92);
    expect(actualRms).toBeLessThan(expectedRms * 1.08);
  });
});

describe('estimateStemBytes', () => {
  it('keeps a four-minute song well inside the cache limit', () => {
    const codec = createOpusStemCodec();
    const fourMinutes = 240 * 44100;
    const perStem = codec.estimateStemBytes({
      sampleRate: 44100,
      frames: fourMinutes,
    });
    const song = perStem * 4;

    expect(perStem).toBeGreaterThan((240 * OPUS_BITRATE) / 8);
    expect(perStem).toBeLessThan(5 * 1024 * 1024);
    expect(song).toBeLessThan(CACHE_ENTRY_LIMIT_BYTES);
    expect(song).toBeLessThan(20 * 1024 * 1024);
  });
});

describe('the Opus codec without WebCodecs', () => {
  it('refuses to start rather than fall back to uncompressed PCM', async () => {
    const codec = createOpusStemCodec();
    await expect(
      codec.createEncoder({ sampleRate: 44100, frames: 1000 }),
    ).rejects.toThrow(/not available/u);
  });
});
