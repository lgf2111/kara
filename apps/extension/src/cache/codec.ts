import type { StereoChannels } from './entry.ts';

/**
 * The private audio format of the cache: Opus in the browser's own encoder.
 *
 * Opus is fixed at 48 kHz. Stems are separated at the source rate (44.1 kHz
 * for htdemucs), so the encoder resamples on the way in and the decoder
 * resamples on the way out, with a cubic kernel. That keeps a four-minute song
 * near fifteen megabytes instead of the three hundred it costs as float32
 * PCM. The resampler and the Opus delay are the only things the rest of the
 * cache knows about; callers always see float32 at their own sample rate.
 *
 * `AudioEncoder` and `AudioDecoder` are not constructed until they are used,
 * so importing this module in Node for the tests is harmless. When they are
 * missing the cache refuses to write rather than quietly falling back to a
 * format that would not fit the limit. That is a deliberate product choice:
 * a 16-bit PCM fallback costs about 161 MB per four-minute song.
 */

export const OPUS_CODEC_ID = 'opus';
export const OPUS_CODEC_RATE = 48000;
export const OPUS_BITRATE = 128_000;
/**
 * A Duet voice is mono. 112 kbps sits inside the 96–128 kbps the product
 * asks for and keeps a four-minute pair near seven megabytes.
 */
export const OPUS_MONO_BITRATE = 112_000;
/**
 * Chrome's Opus decoder returns the encoder's 312-sample pre-roll. The encoder
 * is always fed 48 kHz audio, so this is a constant rather than a function of
 * the source rate. It is written into each file header so a later format can
 * notice a change instead of shifting every stem by six milliseconds.
 */
export const OPUS_DELAY_FRAMES = 312;
const OPUS_PACKET_SECONDS = 0.02;

export interface CodecInput {
  readonly sampleRate: number;
  readonly frames: number;
}

/** One stem's worth of packets, ready to be framed and stored. */
export interface StemEncoder {
  /** Feeds one contiguous block of source-rate audio. */
  encode(left: Float32Array, right: Float32Array): Promise<void>;
  /** Flushes the encoder and returns every packet in order. */
  finish(): Promise<readonly Uint8Array[]>;
  /** Releases the codec without producing a usable stream. */
  abort(): void;
}

/** One mono voice's worth of packets, ready to be framed and stored. */
export interface MonoStemEncoder {
  /** Feeds one contiguous block of source-rate mono audio. */
  encode(mono: Float32Array): Promise<void>;
  /** Flushes the encoder and returns every packet in order. */
  finish(): Promise<readonly Uint8Array[]>;
  /** Releases the codec without producing a usable stream. */
  abort(): void;
}

export interface StemCodec {
  readonly id: string;
  /** The rate every stored packet decodes at. */
  readonly codecRate: number;
  /** Samples of leading silence the decoder must drop. */
  readonly delayFrames: number;
  /** A conservative upper bound for one stem's encoded bytes. */
  estimateStemBytes(input: CodecInput): number;
  createEncoder(input: CodecInput): Promise<StemEncoder>;
  decode(packets: readonly Uint8Array[], input: CodecInput): Promise<StereoChannels>;
  /** The same codec for one voice; the Duet sidecar stores mono. */
  estimateMonoBytes(input: CodecInput): number;
  createMonoEncoder(input: CodecInput): Promise<MonoStemEncoder>;
  decodeMono(
    packets: readonly Uint8Array[],
    input: CodecInput,
  ): Promise<Float32Array>;
}

/** Catmull-Rom interpolation, with the four taps around one output sample. */
function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  return ((a * t + b) * t + c) * t + p1;
}

/** How many source samples are needed after an output sample's floor. */
const RESAMPLER_LOOKAHEAD = 2;
const RESAMPLER_HISTORY = 4;

/**
 * A streaming resampler for the encode side.
 *
 * Blocks arrive one at a time, so an output sample near a block's end may need
 * two samples from the next block. Those outputs are held back and produced on
 * the next call; the last handful are flushed with zeroes at `finish`. The
 * result is a continuous stream rather than a block-wise resample with a
 * seam every segment.
 */
class StreamingCubicResampler {
  private readonly step: number;
  private inputFrames = 0;
  private outputFrames = 0;
  private readonly leftHistory: number[] = [];
  private readonly rightHistory: number[] = [];

  constructor(sourceRate: number, targetRate: number) {
    this.step = sourceRate / targetRate;
  }

  private sample(
    history: readonly number[],
    block: Float32Array,
    blockStart: number,
    blockFrames: number,
    index: number,
  ): number {
    if (index < blockStart) {
      const back = blockStart - index;
      return history[history.length - back] ?? 0;
    }
    const local = index - blockStart;
    return local >= 0 && local < blockFrames ? (block[local] ?? 0) : 0;
  }

  push(left: Float32Array, right: Float32Array): StereoChannels {
    const blockStart = this.inputFrames;
    const availableEnd = blockStart + left.length - RESAMPLER_LOOKAHEAD;
    const endOut = Math.max(
      this.outputFrames,
      Math.ceil(availableEnd / this.step),
    );
    const count = endOut - this.outputFrames;
    const outLeft = new Float32Array(count);
    const outRight = new Float32Array(count);
    for (let offset = 0; offset < count; offset += 1) {
      const position = (this.outputFrames + offset) * this.step;
      const index = Math.floor(position);
      const t = position - index;
      outLeft[offset] = cubic(
        this.sample(this.leftHistory, left, blockStart, left.length, index - 1),
        this.sample(this.leftHistory, left, blockStart, left.length, index),
        this.sample(this.leftHistory, left, blockStart, left.length, index + 1),
        this.sample(this.leftHistory, left, blockStart, left.length, index + 2),
        t,
      );
      outRight[offset] = cubic(
        this.sample(this.rightHistory, right, blockStart, right.length, index - 1),
        this.sample(this.rightHistory, right, blockStart, right.length, index),
        this.sample(this.rightHistory, right, blockStart, right.length, index + 1),
        this.sample(this.rightHistory, right, blockStart, right.length, index + 2),
        t,
      );
    }
    this.outputFrames = endOut;
    this.inputFrames += left.length;
    for (let index = Math.max(0, left.length - RESAMPLER_HISTORY); index < left.length; index += 1) {
      this.leftHistory.push(left[index] ?? 0);
      this.rightHistory.push(right[index] ?? 0);
    }
    if (this.leftHistory.length > RESAMPLER_HISTORY) {
      this.leftHistory.splice(0, this.leftHistory.length - RESAMPLER_HISTORY);
      this.rightHistory.splice(0, this.rightHistory.length - RESAMPLER_HISTORY);
    }
    return { left: outLeft, right: outRight };
  }

  finish(): StereoChannels {
    const totalOut = Math.ceil(this.inputFrames / this.step);
    const count = Math.max(0, totalOut - this.outputFrames);
    const outLeft = new Float32Array(count);
    const outRight = new Float32Array(count);
    for (let offset = 0; offset < count; offset += 1) {
      const position = (this.outputFrames + offset) * this.step;
      const index = Math.floor(position);
      const t = position - index;
      outLeft[offset] = cubic(
        this.sampleFinish(this.leftHistory, index - 1),
        this.sampleFinish(this.leftHistory, index),
        this.sampleFinish(this.leftHistory, index + 1),
        this.sampleFinish(this.leftHistory, index + 2),
        t,
      );
      outRight[offset] = cubic(
        this.sampleFinish(this.rightHistory, index - 1),
        this.sampleFinish(this.rightHistory, index),
        this.sampleFinish(this.rightHistory, index + 1),
        this.sampleFinish(this.rightHistory, index + 2),
        t,
      );
    }
    this.outputFrames = totalOut;
    return { left: outLeft, right: outRight };
  }

  private sampleFinish(history: readonly number[], index: number): number {
    if (index >= this.inputFrames) {
      return 0;
    }
    const back = this.inputFrames - 1 - index;
    return back >= 0 && back < history.length
      ? (history[history.length - 1 - back] ?? 0)
      : 0;
  }
}

/**
 * One channel of decoded 48 kHz audio, resampled to the caller's rate.
 *
 * The cache stores the whole stem, so this is the non-streaming half; it
 * always returns exactly `frames` samples, zero-padding a short decode and
 * dropping anything past the original length. Opus and the resampler may each
 * add samples at the end, and a video's frame count is what the player aligns
 * to.
 */
export function resampleChannel(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
  frames: number,
): Float32Array {
  const out = new Float32Array(frames);
  if (sourceRate === targetRate) {
    out.set(input.subarray(0, Math.min(frames, input.length)));
    return out;
  }
  const step = sourceRate / targetRate;
  for (let index = 0; index < frames; index += 1) {
    const position = index * step;
    const base = Math.floor(position);
    const t = position - base;
    out[index] = cubic(
      input[base - 1] ?? 0,
      input[base] ?? 0,
      input[base + 1] ?? 0,
      input[base + 2] ?? 0,
      t,
    );
  }
  return out;
}

function supportError(name: string): Error {
  return new Error(`stem cache: ${name} is not available in this browser`);
}

function codecFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('stem cache: the audio codec failed');
}

class OpusStemEncoder implements StemEncoder {
  private readonly encoder: AudioEncoder;
  private readonly resampler: StreamingCubicResampler | null;
  private readonly packets: Uint8Array[] = [];
  private failure: Error | null = null;
  private encodedFrames = 0;
  private closed = false;

  constructor(input: CodecInput) {
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.packets.push(bytes);
      },
      error: (error) => {
        this.failure ??= codecFailure(error);
      },
    });
    this.encoder.configure({
      codec: OPUS_CODEC_ID,
      sampleRate: OPUS_CODEC_RATE,
      numberOfChannels: 2,
      bitrate: OPUS_BITRATE,
    });
    this.resampler =
      input.sampleRate === OPUS_CODEC_RATE
        ? null
        : new StreamingCubicResampler(input.sampleRate, OPUS_CODEC_RATE);
  }

  private check(): void {
    if (this.failure !== null) {
      throw this.failure;
    }
  }

  private feed(channels: StereoChannels): void {
    if (channels.left.length === 0) {
      return;
    }
    const planar = new Float32Array(channels.left.length * 2);
    planar.set(channels.left, 0);
    planar.set(channels.right, channels.left.length);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_CODEC_RATE,
      numberOfFrames: channels.left.length,
      numberOfChannels: 2,
      timestamp: Math.round((this.encodedFrames / OPUS_CODEC_RATE) * 1e6),
      data: planar,
    });
    this.encodedFrames += channels.left.length;
    try {
      this.encoder.encode(data);
    } finally {
      data.close();
    }
  }

  encode(left: Float32Array, right: Float32Array): Promise<void> {
    try {
      this.check();
      this.feed(this.resampler === null ? { left, right } : this.resampler.push(left, right));
      this.check();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async finish(): Promise<readonly Uint8Array[]> {
    this.check();
    if (this.resampler !== null) {
      this.feed(this.resampler.finish());
    }
    try {
      await this.encoder.flush();
    } catch (error) {
      this.failure = codecFailure(error);
      throw this.failure;
    }
    this.closed = true;
    this.encoder.close();
    this.check();
    return this.packets;
  }

  abort(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.encoder.close();
      } catch {
        // Closing an encoder that already failed is allowed to throw.
      }
    }
  }
}

class OpusMonoEncoder implements MonoStemEncoder {
  private readonly encoder: AudioEncoder;
  private readonly resampler: StreamingCubicResampler | null;
  private readonly packets: Uint8Array[] = [];
  private failure: Error | null = null;
  private encodedFrames = 0;
  private closed = false;

  constructor(input: CodecInput) {
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.packets.push(bytes);
      },
      error: (error) => {
        this.failure ??= codecFailure(error);
      },
    });
    this.encoder.configure({
      codec: OPUS_CODEC_ID,
      sampleRate: OPUS_CODEC_RATE,
      numberOfChannels: 1,
      bitrate: OPUS_MONO_BITRATE,
    });
    this.resampler =
      input.sampleRate === OPUS_CODEC_RATE
        ? null
        : new StreamingCubicResampler(input.sampleRate, OPUS_CODEC_RATE);
  }

  private check(): void {
    if (this.failure !== null) {
      throw this.failure;
    }
  }

  private feed(mono: Float32Array): void {
    if (mono.length === 0) {
      return;
    }
    const planar = new Float32Array(mono.length);
    planar.set(mono);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_CODEC_RATE,
      numberOfFrames: planar.length,
      numberOfChannels: 1,
      timestamp: Math.round((this.encodedFrames / OPUS_CODEC_RATE) * 1e6),
      data: planar,
    });
    this.encodedFrames += mono.length;
    try {
      this.encoder.encode(data);
    } finally {
      data.close();
    }
  }

  encode(mono: Float32Array): Promise<void> {
    try {
      this.check();
      const resampled =
        this.resampler === null ? mono : this.resampler.push(mono, mono).left;
      this.feed(resampled);
      this.check();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async finish(): Promise<readonly Uint8Array[]> {
    this.check();
    if (this.resampler !== null) {
      this.feed(this.resampler.finish().left);
    }
    try {
      await this.encoder.flush();
    } catch (error) {
      this.failure = codecFailure(error);
      throw this.failure;
    }
    this.closed = true;
    this.encoder.close();
    this.check();
    return this.packets;
  }

  abort(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.encoder.close();
      } catch {
        // Closing an encoder that already failed is allowed to throw.
      }
    }
  }
}

class OpusStemCodec implements StemCodec {
  readonly id = OPUS_CODEC_ID;
  readonly codecRate = OPUS_CODEC_RATE;
  readonly delayFrames = OPUS_DELAY_FRAMES;
  private supported: Promise<boolean> | null = null;
  private monoSupported: Promise<boolean> | null = null;

  private async checkSupport(): Promise<void> {
    if (
      typeof AudioEncoder === 'undefined' ||
      typeof AudioDecoder === 'undefined' ||
      typeof AudioEncoder.isConfigSupported !== 'function' ||
      typeof AudioDecoder.isConfigSupported !== 'function'
    ) {
      throw supportError('Opus');
    }
    this.supported ??= (async () => {
      try {
        const encoder = await AudioEncoder.isConfigSupported({
          codec: OPUS_CODEC_ID,
          sampleRate: OPUS_CODEC_RATE,
          numberOfChannels: 2,
          bitrate: OPUS_BITRATE,
        });
        const decoder = await AudioDecoder.isConfigSupported({
          codec: OPUS_CODEC_ID,
          sampleRate: OPUS_CODEC_RATE,
          numberOfChannels: 2,
        });
        return encoder.supported === true && decoder.supported === true;
      } catch {
        return false;
      }
    })();
    if (!(await this.supported)) {
      throw supportError('Opus');
    }
  }

  private async checkMonoSupport(): Promise<void> {
    if (
      typeof AudioEncoder === 'undefined' ||
      typeof AudioDecoder === 'undefined' ||
      typeof AudioEncoder.isConfigSupported !== 'function' ||
      typeof AudioDecoder.isConfigSupported !== 'function'
    ) {
      throw supportError('Opus');
    }
    this.monoSupported ??= (async () => {
      try {
        const encoder = await AudioEncoder.isConfigSupported({
          codec: OPUS_CODEC_ID,
          sampleRate: OPUS_CODEC_RATE,
          numberOfChannels: 1,
          bitrate: OPUS_MONO_BITRATE,
        });
        const decoder = await AudioDecoder.isConfigSupported({
          codec: OPUS_CODEC_ID,
          sampleRate: OPUS_CODEC_RATE,
          numberOfChannels: 1,
        });
        return encoder.supported === true && decoder.supported === true;
      } catch {
        return false;
      }
    })();
    if (!(await this.monoSupported)) {
      throw supportError('Opus');
    }
  }

  estimateStemBytes(input: CodecInput): number {
    const seconds = input.frames / input.sampleRate;
    const payload = (seconds * OPUS_BITRATE) / 8;
    const packets = Math.ceil(seconds / OPUS_PACKET_SECONDS) * 4;
    // VBR can run a little over the target rate on a transient; the margin is
    // the difference between a clean eviction and a quota failure at the end
    // of a long separation.
    return Math.ceil(payload * 1.05) + packets + 256;
  }

  estimateMonoBytes(input: CodecInput): number {
    const seconds = input.frames / input.sampleRate;
    const payload = (seconds * OPUS_MONO_BITRATE) / 8;
    const packets = Math.ceil(seconds / OPUS_PACKET_SECONDS) * 4;
    return Math.ceil(payload * 1.05) + packets + 256;
  }

  async createEncoder(input: CodecInput): Promise<StemEncoder> {
    await this.checkSupport();
    return new OpusStemEncoder(input);
  }

  async createMonoEncoder(input: CodecInput): Promise<MonoStemEncoder> {
    await this.checkMonoSupport();
    return new OpusMonoEncoder(input);
  }

  async decode(
    packets: readonly Uint8Array[],
    input: CodecInput,
  ): Promise<StereoChannels> {
    await this.checkSupport();
    let failure: Error | null = null;
    const pieces: Array<{ readonly left: Float32Array; readonly right: Float32Array }> = [];
    const decoder = new AudioDecoder({
      output: (data) => {
        try {
          const left = new Float32Array(data.numberOfFrames);
          const right = new Float32Array(data.numberOfFrames);
          data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
          data.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
          pieces.push({ left, right });
        } catch (error) {
          failure ??= codecFailure(error);
        } finally {
          data.close();
        }
      },
      error: (error) => {
        failure ??= codecFailure(error);
      },
    });
    decoder.configure({
      codec: OPUS_CODEC_ID,
      sampleRate: OPUS_CODEC_RATE,
      numberOfChannels: 2,
    });
    try {
      for (const [index, packet] of packets.entries()) {
        decoder.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: index * OPUS_PACKET_SECONDS * 1e6,
            data: packet,
          }),
        );
      }
      await decoder.flush();
    } finally {
      try {
        decoder.close();
      } catch {
        // The decoder may already be closed after a failed flush.
      }
    }
    if (failure !== null) {
      throw failure;
    }

    let total = 0;
    for (const piece of pieces) {
      total += piece.left.length;
    }
    if (total <= OPUS_DELAY_FRAMES) {
      throw new Error('stem cache: the audio stream is empty');
    }
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let at = 0;
    for (const piece of pieces) {
      left.set(piece.left, at);
      right.set(piece.right, at);
      at += piece.left.length;
    }
    const trimmedLeft = left.subarray(OPUS_DELAY_FRAMES);
    const trimmedRight = right.subarray(OPUS_DELAY_FRAMES);
    return {
      left: resampleChannel(trimmedLeft, OPUS_CODEC_RATE, input.sampleRate, input.frames),
      right: resampleChannel(trimmedRight, OPUS_CODEC_RATE, input.sampleRate, input.frames),
    };
  }

  async decodeMono(
    packets: readonly Uint8Array[],
    input: CodecInput,
  ): Promise<Float32Array> {
    await this.checkMonoSupport();
    let failure: Error | null = null;
    const pieces: Float32Array[] = [];
    const decoder = new AudioDecoder({
      output: (data) => {
        try {
          const mono = new Float32Array(data.numberOfFrames);
          data.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
          pieces.push(mono);
        } catch (error) {
          failure ??= codecFailure(error);
        } finally {
          data.close();
        }
      },
      error: (error) => {
        failure ??= codecFailure(error);
      },
    });
    decoder.configure({
      codec: OPUS_CODEC_ID,
      sampleRate: OPUS_CODEC_RATE,
      numberOfChannels: 1,
    });
    try {
      for (const [index, packet] of packets.entries()) {
        decoder.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: index * OPUS_PACKET_SECONDS * 1e6,
            data: packet,
          }),
        );
      }
      await decoder.flush();
    } finally {
      try {
        decoder.close();
      } catch {
        // The decoder may already be closed after a failed flush.
      }
    }
    if (failure !== null) {
      throw failure;
    }

    let total = 0;
    for (const piece of pieces) {
      total += piece.length;
    }
    if (total <= OPUS_DELAY_FRAMES) {
      throw new Error('stem cache: the audio stream is empty');
    }
    const mono = new Float32Array(total);
    let at = 0;
    for (const piece of pieces) {
      mono.set(piece, at);
      at += piece.length;
    }
    return resampleChannel(
      mono.subarray(OPUS_DELAY_FRAMES),
      OPUS_CODEC_RATE,
      input.sampleRate,
      input.frames,
    );
  }
}

export function createOpusStemCodec(): StemCodec {
  return new OpusStemCodec();
}
