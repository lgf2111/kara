/**
 * What a stage lets the room do with whatever is playing.
 *
 * One shape for both stages, because the overlaid controls are the same bar
 * either way and should not know which of them they are sitting on. A video
 * element answers these itself; a song that is nothing but stems answers them
 * from the audio clock.
 */
export interface Transport {
  readonly playing: boolean;
  readonly currentSeconds: number;
  /** NaN until whatever is playing has read its own length. */
  readonly durationSeconds: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly fullscreen: boolean;
  toggle(): void;
  /** Relative, in seconds. */
  skip(seconds: number): void;
  /** An absolute time, from dragging the bar. */
  seek(seconds: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  toggleFullscreen(): void;
}
