import type { Store } from '../storage/store.ts';
import {
  STEM_CHANNELS,
  frameCount,
  spreadChannels,
  stemPosition,
  type StemAnchor,
  type StemGains,
} from './stem-mix.ts';

/**
 * The stems as Web Audio: read out of the filesystem into buffers, then
 * started and stopped against the video's clock. The browser parts live here
 * so `stem-mix.ts` stays testable.
 */

/** Frames read at a time: half a megabyte of interleaved stereo float32. */
const CHUNK_FRAMES = 1 << 16;

const FRAME_BYTES = STEM_CHANNELS * Float32Array.BYTES_PER_ELEMENT;

export interface StemPaths {
  readonly instrumental: string;
  readonly vocals: string;
}

export interface StemBuffers {
  readonly instrumental: AudioBuffer;
  readonly vocals: AudioBuffer;
}

/**
 * One stem into one buffer, a chunk at a time.
 *
 * The buffer is the only copy that lasts: each chunk is read, spread into two
 * scratch arrays and handed to the buffer, so a four-minute stem never exists
 * twice over. Returns null if the caller gave up while this was reading.
 */
async function readStem(
  context: BaseAudioContext,
  store: Store,
  path: string,
  frames: number,
  sampleRate: number,
  dropped: () => boolean,
): Promise<AudioBuffer | null> {
  const buffer = context.createBuffer(STEM_CHANNELS, frames, sampleRate);
  const scratch: Float32Array[] = [];
  for (let channel = 0; channel < STEM_CHANNELS; channel += 1) {
    scratch.push(new Float32Array(CHUNK_FRAMES));
  }

  for (let frame = 0; frame < frames; frame += CHUNK_FRAMES) {
    if (dropped()) {
      return null;
    }
    const wanted = Math.min(CHUNK_FRAMES, frames - frame);
    const bytes = await store.readBytes(path, frame * FRAME_BYTES, wanted * FRAME_BYTES);
    if (bytes === null) {
      throw new Error(`${path} ended after ${String(frame)} of ${String(frames)} frames`);
    }
    // A float view needs a four-byte boundary, which a store is not obliged
    // to hand back on.
    const aligned = bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0 ? bytes : new Uint8Array(bytes);
    const interleaved = new Float32Array(
      aligned.buffer,
      aligned.byteOffset,
      Math.floor(aligned.byteLength / Float32Array.BYTES_PER_ELEMENT),
    );
    const written = spreadChannels(interleaved, scratch, wanted);
    if (written === 0) {
      break;
    }
    for (let channel = 0; channel < STEM_CHANNELS; channel += 1) {
      const filled = scratch[channel];
      if (filled !== undefined) {
        buffer.copyToChannel(filled.subarray(0, written) as Float32Array<ArrayBuffer>, channel, frame);
      }
    }
  }
  return buffer;
}

/**
 * Both stems of one song. They are played as a pair against the same picture,
 * so they are cut to the shorter of the two: a frame one of them does not
 * have is a frame neither can be trusted on.
 */
export async function loadStemBuffers(
  context: BaseAudioContext,
  store: Store,
  paths: StemPaths,
  sampleRate: number,
  dropped: () => boolean,
): Promise<StemBuffers | null> {
  const sizes = new Map<string, number>();
  for (const path of [paths.instrumental, paths.vocals]) {
    const bytes = await store.sizeOf(path);
    if (bytes === null) {
      throw new Error(`the stems separated for this song are gone from ${path}`);
    }
    sizes.set(path, bytes);
  }
  const frames = Math.min(
    frameCount(sizes.get(paths.instrumental) ?? 0),
    frameCount(sizes.get(paths.vocals) ?? 0),
  );
  if (frames === 0) {
    throw new Error('the stems separated for this song hold no audio');
  }

  const instrumental = await readStem(context, store, paths.instrumental, frames, sampleRate, dropped);
  if (instrumental === null) {
    return null;
  }
  const vocals = await readStem(context, store, paths.vocals, frames, sampleRate, dropped);
  if (vocals === null) {
    return null;
  }
  return { instrumental, vocals };
}

/**
 * What is scheduled now is heard this much later. Worth knowing: on this
 * machine it runs to tens of milliseconds, which is most of the drift budget
 * before a listener would notice the voice sitting behind the picture.
 */
function latencySeconds(context: AudioContext): number {
  const output = context.outputLatency;
  const base = context.baseLatency;
  const total = (Number.isFinite(output) ? output : 0) + (Number.isFinite(base) ? base : 0);
  // A browser that will not say reports nothing, which just means no shift.
  return Math.min(0.5, Math.max(0, total));
}

/** Smooth enough that moving the fader does not click. */
const RAMP_SECONDS = 0.015;

export interface StemMixer {
  /** Plays both stems from this point in the song, replacing anything playing. */
  start(mediaSeconds: number, rate: number): void;
  stop(): void;
  /** Where the stems have reached, or null while nothing is playing. */
  position(): number | null;
  setGains(gains: StemGains): void;
  /** Gives up the buffers and the output device. */
  close(): Promise<void>;
}

export function createStemMixer(context: AudioContext, buffers: StemBuffers): StemMixer {
  const instrumentalGain = context.createGain();
  const vocalsGain = context.createGain();
  // Silent until asked for, so becoming ready mid-song cannot blurt.
  instrumentalGain.gain.value = 0;
  vocalsGain.gain.value = 0;
  instrumentalGain.connect(context.destination);
  vocalsGain.connect(context.destination);

  const tracks = [
    { buffer: buffers.instrumental, gain: instrumentalGain },
    { buffer: buffers.vocals, gain: vocalsGain },
  ] as const;

  let sources: AudioBufferSourceNode[] = [];
  let anchor: StemAnchor | null = null;

  const stop = (): void => {
    for (const source of sources) {
      source.stop();
      source.disconnect();
    }
    sources = [];
    anchor = null;
  };

  return {
    start(mediaSeconds, rate) {
      stop();
      const playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
      const at = Math.max(0, Number.isFinite(mediaSeconds) ? mediaSeconds : 0);
      if (at >= buffers.instrumental.duration) {
        // Past the end of what was separated: the picture plays on alone.
        return;
      }
      // The context starts suspended until something is played, and comes
      // back suspended after the tab has been away.
      void context.resume().catch(() => undefined);

      const contextSeconds = context.currentTime;
      // Started a latency ahead, so what reaches the room lines up with the
      // frame on screen rather than the sample being handed to the device.
      const offset = at + latencySeconds(context) * playbackRate;
      for (const track of tracks) {
        const source = context.createBufferSource();
        source.buffer = track.buffer;
        source.playbackRate.value = playbackRate;
        source.connect(track.gain);
        source.start(contextSeconds, Math.min(offset, track.buffer.duration));
        sources.push(source);
      }
      anchor = { contextSeconds, mediaSeconds: at, rate: playbackRate };
    },
    stop,
    position() {
      return anchor === null ? null : stemPosition(anchor, context.currentTime);
    },
    setGains(gains) {
      const now = context.currentTime;
      instrumentalGain.gain.setTargetAtTime(gains.instrumental, now, RAMP_SECONDS);
      vocalsGain.gain.setTargetAtTime(gains.vocals, now, RAMP_SECONDS);
    },
    async close() {
      stop();
      instrumentalGain.disconnect();
      vocalsGain.disconnect();
      await context.close();
    },
  };
}
