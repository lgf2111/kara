import { clampVolume } from './time.ts';

/**
 * The arithmetic behind playing a song's stems, alongside the file it came
 * from or, for a song that kept none, on their own. Kept away from Web Audio
 * so it can be tested without a browser.
 *
 * Two clocks are involved and only one of them can be driven: the media
 * element keeps time, and a buffer source, once started, runs on the audio
 * device's clock. So the stems are started from wherever the element is and
 * restarted when the two have come apart.
 */

/** Stems are written interleaved stereo; see `separation/separate.worker.ts`. */
export const STEM_CHANNELS = 2;

/** What the ingest decoder resamples to, and so what a stem holds. */
export const STEM_SAMPLE_RATE = 44100;

/** Apart by more than this and a listener hears the seam. */
export const DRIFT_TOLERANCE_SECONDS = 0.06;

/** How often the two clocks are compared. */
export const DRIFT_CHECK_MS = 500;

export type VocalMode = 'original' | 'instrumental';

export interface VocalChoice {
  readonly mode: VocalMode;
  /** How much of the vocal comes back as a guide, 0 to 100. */
  readonly guidePercent: number;
}

/**
 * What a song goes on as: itself.
 *
 * Nothing waits for separation, so a song starts the instant its file is in,
 * and at that moment there is nothing but the song as it arrived. Switching
 * to the instrumental is the room's to ask for once it can be given, which is
 * a button lighting up rather than a song changing under them.
 */
export const ORIGINAL_CHOICE: VocalChoice = { mode: 'original', guidePercent: 0 };

/** How far the stems have got towards being playable. */
export type StemMixState = 'absent' | 'loading' | 'ready' | 'failed';

/** What a control needs to know about the stems: are they here, and if not why. */
export interface StemReadiness {
  readonly state: StemMixState;
  readonly error: string | null;
}

/** Frames in a stem of this many bytes. A short tail of odd bytes is ignored. */
export function frameCount(bytes: number, channels = STEM_CHANNELS): number {
  if (!Number.isFinite(bytes) || bytes <= 0 || channels <= 0) {
    return 0;
  }
  return Math.floor(bytes / (channels * Float32Array.BYTES_PER_ELEMENT));
}

/**
 * Interleaved frames out into one array per channel: `[L, R, L, R, …]` becomes
 * left and right, which is what an AudioBuffer channel wants.
 *
 * The caller owns both sides, so a long stem can be moved a chunk at a time
 * through the same two scratch arrays. Returns the frames actually written,
 * which is as many as the shortest of what was given.
 */
export function spreadChannels(
  interleaved: Float32Array,
  channels: readonly Float32Array[],
  frames: number,
): number {
  const count = channels.length;
  if (count === 0 || !Number.isFinite(frames) || frames <= 0) {
    return 0;
  }
  let limit = Math.min(Math.floor(frames), Math.floor(interleaved.length / count));
  for (const channel of channels) {
    limit = Math.min(limit, channel.length);
  }
  for (let frame = 0; frame < limit; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      const target = channels[channel];
      if (target !== undefined) {
        target[frame] = interleaved[frame * count + channel] ?? 0;
      }
    }
  }
  return limit;
}

/**
 * The rate a stem was written at, read off the job state the worker left
 * beside it. Anything unexpected falls back to the decoder's rate rather than
 * refusing to play: a wrong rate is audible and fixable, a blank player is not.
 */
export function stemSampleRate(state: unknown): number {
  if (typeof state === 'object' && state !== null) {
    const source = (state as { source?: unknown }).source;
    if (typeof source === 'object' && source !== null) {
      const rate = (source as { sampleRate?: unknown }).sampleRate;
      if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 8000 && rate <= 192000) {
        return rate;
      }
    }
  }
  return STEM_SAMPLE_RATE;
}

/**
 * The fader as an amplitude. Linear on purpose: the stems add back up to the
 * mixture, so a guide at 100% is the song as it arrived, and 50% is the voice
 * about 6 dB under it.
 */
export function guideGain(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(100, Math.max(0, percent)) / 100;
}

export interface StemGains {
  readonly instrumental: number;
  readonly vocals: number;
}

/**
 * What each stem is worth, given the choice and the player's own volume.
 *
 * In original mode the stems are silent and the picture carries the sound, so
 * the volume control is left to the element. In instrumental mode the stems
 * are the sound, and the same control has to reach them.
 */
export function stemGains(choice: VocalChoice, volume: number, muted: boolean): StemGains {
  if (choice.mode === 'original') {
    return { instrumental: 0, vocals: 0 };
  }
  const out = muted ? 0 : clampVolume(volume);
  return { instrumental: out, vocals: out * guideGain(choice.guidePercent) };
}

/**
 * The same, for a song with no picture, where the stems are the only sound
 * there is.
 *
 * Original cannot mean silence here: the two stems add back up to the
 * mixture, so the song as it arrived is the backing with the voice at full,
 * and the volume has to reach them in both modes.
 */
export function audioStemGains(choice: VocalChoice, volume: number, muted: boolean): StemGains {
  const out = muted ? 0 : clampVolume(volume);
  const voice = choice.mode === 'original' ? 1 : guideGain(choice.guidePercent);
  return { instrumental: out, vocals: out * voice };
}

/** Where the stems were started, and from what point in the song. */
export interface StemAnchor {
  /** The audio clock when they were started. */
  readonly contextSeconds: number;
  /** The video's time at that moment. */
  readonly mediaSeconds: number;
  readonly rate: number;
}

/** Where the stems have reached, in the same seconds the video reports. */
export function stemPosition(anchor: StemAnchor, contextSeconds: number): number {
  const elapsed = Math.max(0, contextSeconds - anchor.contextSeconds);
  return anchor.mediaSeconds + elapsed * anchor.rate;
}

export type DriftAction = 'hold' | 'resync';

/**
 * Whether the stems have come far enough off the video to be worth
 * restarting. A restart is a gap of its own, so it has to be the lesser of
 * the two evils; a time neither clock will report yet is left alone.
 */
export function driftAction(
  videoSeconds: number,
  stemSeconds: number,
  toleranceSeconds = DRIFT_TOLERANCE_SECONDS,
): DriftAction {
  if (!Number.isFinite(videoSeconds) || !Number.isFinite(stemSeconds)) {
    return 'hold';
  }
  return Math.abs(videoSeconds - stemSeconds) > toleranceSeconds ? 'resync' : 'hold';
}
