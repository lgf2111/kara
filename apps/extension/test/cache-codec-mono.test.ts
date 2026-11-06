import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPUS_MONO_BITRATE,
  OPUS_DELAY_FRAMES,
  createOpusStemCodec,
} from '../src/cache/codec.ts';

/**
 * A tiny WebCodecs stand-in that passes audio through and keeps the encoder
 * delay. It lets the mono path be checked in Node without pretending this is a
 * real Opus bitstream: the framing, delay trim and exact frame count are the
 * parts the cache owns.
 */
class FakeAudioData {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  private readonly channels: readonly Float32Array[];

  constructor(init: {
    readonly sampleRate: number;
    readonly numberOfFrames: number;
    readonly numberOfChannels: number;
    readonly data: Float32Array | ArrayBuffer;
  }) {
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.sampleRate = init.sampleRate;
    const samples =
      init.data instanceof Float32Array
        ? new Float32Array(init.data)
        : new Float32Array(init.data);
    const channels: Float32Array[] = [];
    for (let index = 0; index < init.numberOfChannels; index += 1) {
      channels.push(
        samples.subarray(
          index * init.numberOfFrames,
          (index + 1) * init.numberOfFrames,
        ),
      );
    }
    this.channels = channels;
  }

  copyTo(
    destination: Float32Array,
    options?: { readonly planeIndex?: number; readonly format?: string },
  ): void {
    const plane = this.channels[options?.planeIndex ?? 0];
    if (plane !== undefined) {
      destination.set(plane.subarray(0, destination.length));
    }
  }

  close(): void {}
}

class FakeEncodedAudioChunk {
  readonly bytes: Uint8Array;

  constructor(init: { readonly data: Uint8Array }) {
    this.bytes = new Uint8Array(init.data);
  }

  get byteLength(): number {
    return this.bytes.byteLength;
  }

  copyTo(destination: Uint8Array): void {
    destination.set(this.bytes.subarray(0, destination.byteLength));
  }
}

type EncoderOutput = (chunk: FakeEncodedAudioChunk) => void;

class FakeAudioEncoder {
  static readonly instances: FakeAudioEncoder[] = [];
  readonly configs: Array<Record<string, unknown>> = [];
  private readonly output: EncoderOutput;
  private samples: Float32Array[] = [];
  private delayWritten = false;
  private closed = false;

  static isConfigSupported(config: Record<string, unknown>): Promise<{
    readonly supported: boolean;
    readonly config: Record<string, unknown>;
  }> {
    return Promise.resolve({ supported: true, config });
  }

  constructor(init: {
    readonly output: EncoderOutput;
    readonly error: (error: Error) => void;
  }) {
    this.output = init.output;
    FakeAudioEncoder.instances.push(this);
  }

  configure(config: Record<string, unknown>): void {
    this.configs.push(config);
  }

  encode(data: FakeAudioData): void {
    const plane = new Float32Array(data.numberOfFrames);
    data.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
    if (!this.delayWritten) {
      this.samples.push(new Float32Array(OPUS_DELAY_FRAMES));
      this.delayWritten = true;
    }
    this.samples.push(plane);
  }

  async flush(): Promise<void> {
    let frames = 0;
    for (const samples of this.samples) {
      frames += samples.length;
    }
    const mono = new Float32Array(frames);
    let at = 0;
    for (const samples of this.samples) {
      mono.set(samples, at);
      at += samples.length;
    }
    this.samples = [];
    const bytes = new Uint8Array(mono.buffer);
    this.output(new FakeEncodedAudioChunk({ data: bytes }));
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

class FakeAudioDecoder {
  private samples: Float32Array[] = [];
  private readonly output: (data: FakeAudioData) => void;

  static isConfigSupported(config: Record<string, unknown>): Promise<{
    readonly supported: boolean;
    readonly config: Record<string, unknown>;
  }> {
    return Promise.resolve({ supported: true, config });
  }

  constructor(init: {
    readonly output: (data: FakeAudioData) => void;
    readonly error: (error: Error) => void;
  }) {
    this.output = init.output;
  }

  configure(): void {}

  decode(chunk: FakeEncodedAudioChunk): void {
    const bytes = new Uint8Array(chunk.bytes);
    this.samples.push(
      new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    );
  }

  async flush(): Promise<void> {
    let frames = 0;
    for (const samples of this.samples) {
      frames += samples.length;
    }
    const mono = new Float32Array(frames);
    let at = 0;
    for (const samples of this.samples) {
      mono.set(samples, at);
      at += samples.length;
    }
    this.samples = [];
    this.output(
      new FakeAudioData({
        sampleRate: 48000,
        numberOfFrames: mono.length,
        numberOfChannels: 1,
        data: mono,
      }),
    );
  }

  close(): void {}
}

function tone(frames: number, sampleRate: number, hz = 1000): Float32Array {
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    samples[index] = 0.4 * Math.sin(2 * Math.PI * hz * (index / sampleRate));
  }
  return samples;
}

beforeEach(() => {
  FakeAudioEncoder.instances.length = 0;
  vi.stubGlobal('AudioEncoder', FakeAudioEncoder);
  vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
  vi.stubGlobal('AudioData', FakeAudioData);
  vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the mono Opus path', () => {
  it('round-trips a 48 kHz voice at the exact frame count', async () => {
    const codec = createOpusStemCodec();
    const frames = 5000;
    const source = tone(frames, 48000);

    const encoder = await codec.createMonoEncoder({
      sampleRate: 48000,
      frames,
    });
    await encoder.encode(source);
    const packets = await encoder.finish();
    expect(packets.length).toBeGreaterThan(0);

    const config = FakeAudioEncoder.instances[0]?.configs[0];
    expect(config?.['numberOfChannels']).toBe(1);
    expect(config?.['bitrate']).toBe(OPUS_MONO_BITRATE);

    const decoded = await codec.decodeMono(packets, {
      sampleRate: 48000,
      frames,
    });
    expect(decoded.length).toBe(frames);
    expect(decoded[100]).toBeCloseTo(source[100] ?? 0, 4);
    expect(decoded[frames - 100]).toBeCloseTo(source[frames - 100] ?? 0, 4);
  });

  it('round-trips a 44.1 kHz voice at the exact frame count', async () => {
    const codec = createOpusStemCodec();
    const frames = 4410;
    const source = tone(frames, 44100);

    const encoder = await codec.createMonoEncoder({
      sampleRate: 44100,
      frames,
    });
    await encoder.encode(source);
    const packets = await encoder.finish();
    const decoded = await codec.decodeMono(packets, {
      sampleRate: 44100,
      frames,
    });

    expect(decoded.length).toBe(frames);
    let expected = 0;
    let actual = 0;
    for (let index = 200; index < frames - 200; index += 1) {
      expected += (source[index] ?? 0) ** 2;
      actual += (decoded[index] ?? 0) ** 2;
    }
    expect(Math.sqrt(actual / (frames - 400))).toBeGreaterThan(
      Math.sqrt(expected / (frames - 400)) * 0.8,
    );
  });
});
