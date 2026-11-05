/**
 * Decode compressed audio to the two-channel shape the rest of the extension
 * works in.
 *
 * This lives on its own because two callers need it for different reasons:
 * the session decodes the video's stream, and the duet client decodes the two
 * WAVs the helper returns. Both want a stereo pair at the player's rate, with
 * a mono file widened rather than rejected.
 */

import { SAMPLE_RATE } from '../separation/model.ts';

export async function decodeStereo(
  bytes: ArrayBuffer,
  sampleRate = SAMPLE_RATE,
): Promise<[Float32Array, Float32Array]> {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 1,
    sampleRate,
  });
  // decodeAudioData takes ownership of the buffer and detaches it; nothing
  // here reads `bytes` afterwards.
  const buffer = await context.decodeAudioData(bytes);
  const left = new Float32Array(buffer.length);
  left.set(buffer.getChannelData(0));
  const right = buffer.numberOfChannels > 1 ? new Float32Array(buffer.length) : left;
  if (buffer.numberOfChannels > 1) {
    right.set(buffer.getChannelData(1));
  }
  return [left, right];
}
