/**
 * Writing separated stems out as files a person can actually listen to.
 *
 * The pipeline keeps stems in OPFS as raw interleaved float32, which no media
 * player opens. These helpers turn that into 16-bit PCM WAV, the one format
 * everything on a Mac plays without argument. Float WAV would skip the
 * conversion, but Finder previews and QuickTime are unreliable with it.
 */

/** Bytes in a canonical PCM WAV header, before the sample data. */
export const WAV_HEADER_BYTES = 44;

const BYTES_PER_SAMPLE = 2;

/**
 * @typedef {object} WavShape
 * @property {number} frames samples per channel
 * @property {number} channels
 * @property {number} sampleRate
 */

/**
 * A canonical 44-byte PCM WAV header for `frames` frames of 16-bit audio.
 *
 * Written before the samples so the file can be appended to in chunks: a
 * four-minute stem is far too big to hold in memory twice.
 *
 * @param {WavShape} shape
 * @returns {Uint8Array}
 */
export function wavHeader(shape) {
  const { frames, channels, sampleRate } = shape;
  if (!Number.isInteger(frames) || frames < 0) {
    throw new Error(`frames must be a whole number of samples, got ${String(frames)}`);
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`channels must be at least 1, got ${String(channels)}`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1) {
    throw new Error(`sampleRate must be a positive integer, got ${String(sampleRate)}`);
  }

  const dataBytes = frames * channels * BYTES_PER_SAMPLE;
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);

  /**
   * @param {number} offset
   * @param {string} text
   */
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      header[offset + i] = text.charCodeAt(i);
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // size of the fmt chunk
  view.setUint16(20, 1, true); // 1 is uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true);
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true);
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * Converts float samples in [-1, 1] to little-endian 16-bit PCM bytes.
 *
 * Values outside the range are clamped rather than allowed to wrap, which
 * would turn a loud peak into a click. A value that is not finite becomes
 * silence: the worker already refuses a backend that returns NaN, so reaching
 * here means something is wrong and silence is the honest output.
 *
 * @param {Float32Array} samples interleaved, any channel count
 * @param {Uint8Array} [target] reused output, `samples.length * 2` bytes
 * @returns {Uint8Array}
 */
export function floatToPcm16(samples, target = new Uint8Array(samples.length * BYTES_PER_SAMPLE)) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    const finite = Number.isFinite(sample) ? sample : 0;
    const clamped = finite > 1 ? 1 : finite < -1 ? -1 : finite;
    view.setInt16(i * BYTES_PER_SAMPLE, Math.round(clamped * 32767), true);
  }
  return target;
}

/**
 * A single directory name for one run's stems, taken from the input path.
 *
 * The result can never escape its parent or hide itself: separators and other
 * awkward characters collapse to underscores and leading dots go, so a file
 * called `../.ssh` cannot steer the output anywhere.
 *
 * @param {string} inputPath
 * @returns {string}
 */
export function outputNameFor(inputPath) {
  const base = inputPath.slice(inputPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const withoutExtension = dot > 0 ? base.slice(0, dot) : base;
  const safe = withoutExtension
    .replace(/[^a-zA-Z0-9._-]+/gu, '_')
    .replace(/^[._]+/u, '')
    .slice(0, 64);
  return safe.length > 0 ? safe : 'run';
}
