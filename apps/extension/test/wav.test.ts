import { describe, expect, it } from 'vitest';

import { encodeWavMono, WAV_HEADER_BYTES } from '../src/audio/wav.ts';

function text(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(view.getUint8(offset + index));
  }
  return out;
}

describe('encodeWavMono', () => {
  it('writes a readable 16-bit mono WAV header and samples', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWavMono(samples, 44_100);
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);

    expect(blob.type).toBe('audio/wav');
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2);
    expect(text(view, 0, 4)).toBe('RIFF');
    expect(text(view, 8, 4)).toBe('WAVE');
    expect(text(view, 12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16_383);
    expect(view.getInt16(48, true)).toBe(-16_384);
    expect(view.getInt16(50, true)).toBe(32_767);
    expect(view.getInt16(52, true)).toBe(-32_768);
  });

  it('clamps a sample rather than wrapping it', async () => {
    const blob = encodeWavMono(new Float32Array([4, -4]), 16_000);
    const view = new DataView(await blob.arrayBuffer());

    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_768);
  });
});
