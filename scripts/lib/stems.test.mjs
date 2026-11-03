import { describe, expect, it } from 'vitest';

import { WAV_HEADER_BYTES, floatToPcm16, outputNameFor, wavHeader } from './stems.mjs';

/**
 * @param {Uint8Array} bytes
 * @returns {DataView}
 */
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {string}
 */
function tag(bytes, offset) {
  return new TextDecoder().decode(bytes.subarray(offset, offset + 4));
}

describe('wavHeader', () => {
  it('declares uncompressed 16-bit PCM', () => {
    const header = wavHeader({ frames: 100, channels: 2, sampleRate: 44100 });
    const view = viewOf(header);

    expect(header.byteLength).toBe(WAV_HEADER_BYTES);
    expect(tag(header, 0)).toBe('RIFF');
    expect(tag(header, 8)).toBe('WAVE');
    expect(tag(header, 12)).toBe('fmt ');
    expect(tag(header, 36)).toBe('data');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('sizes every chunk from the frame count', () => {
    const frames = 1000;
    const view = viewOf(wavHeader({ frames, channels: 2, sampleRate: 44100 }));
    const dataBytes = frames * 2 * 2;

    expect(view.getUint32(40, true)).toBe(dataBytes);
    expect(view.getUint32(4, true)).toBe(36 + dataBytes);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(44100 * 2 * 2);
    expect(view.getUint16(32, true)).toBe(4);
  });

  it('handles mono, and a header written before any samples exist', () => {
    const view = viewOf(wavHeader({ frames: 0, channels: 1, sampleRate: 16000 }));

    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(28, true)).toBe(16000 * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(0);
  });

  it('refuses a shape it cannot encode', () => {
    expect(() => wavHeader({ frames: -1, channels: 2, sampleRate: 44100 })).toThrow(/frames/u);
    expect(() => wavHeader({ frames: 1.5, channels: 2, sampleRate: 44100 })).toThrow(/frames/u);
    expect(() => wavHeader({ frames: 10, channels: 0, sampleRate: 44100 })).toThrow(/channels/u);
    expect(() => wavHeader({ frames: 10, channels: 2, sampleRate: 0 })).toThrow(/sampleRate/u);
  });
});

describe('floatToPcm16', () => {
  it('maps full scale and keeps sample order', () => {
    const bytes = floatToPcm16(Float32Array.from([0, 1, -1, 0.5]));
    const view = viewOf(bytes);

    expect(bytes.byteLength).toBe(8);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32767);
    expect(view.getInt16(6, true)).toBe(16384);
  });

  it('clamps a peak rather than letting it wrap', () => {
    const view = viewOf(floatToPcm16(Float32Array.from([2, -2, 1.0001])));

    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32767);
    expect(view.getInt16(4, true)).toBe(32767);
  });

  it('writes silence for a value that is not finite', () => {
    const view = viewOf(floatToPcm16(Float32Array.from([Number.NaN, Infinity, -Infinity])));

    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0);
    expect(view.getInt16(4, true)).toBe(0);
  });

  it('fills a buffer the caller supplies, so a long stem needs no garbage', () => {
    const target = new Uint8Array(4);

    const returned = floatToPcm16(Float32Array.from([1, -1]), target);

    expect(returned).toBe(target);
    expect(viewOf(target).getInt16(0, true)).toBe(32767);
    expect(viewOf(target).getInt16(2, true)).toBe(-32767);
  });
});

describe('outputNameFor', () => {
  it('takes the file name without its extension', () => {
    expect(outputNameFor('/music/My Song.mp4')).toBe('My_Song');
    expect(outputNameFor('tone-240s.wav')).toBe('tone-240s');
    expect(outputNameFor('/a/b/track.01.flac')).toBe('track.01');
  });

  it('keeps the name usable as one directory and nothing else', () => {
    expect(outputNameFor('/music/../secret/song.mp3')).toBe('song');
    expect(outputNameFor('odd/na*me?.m4a')).toBe('na_me_');
    expect(outputNameFor('/music/.hidden.wav')).toBe('hidden');
  });

  it('falls back when there is no usable name left', () => {
    expect(outputNameFor('')).toBe('run');
    expect(outputNameFor('/a/b/')).toBe('run');
    expect(outputNameFor('..')).toBe('run');
  });
});
