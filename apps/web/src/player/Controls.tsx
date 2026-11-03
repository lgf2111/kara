import { SKIP_SECONDS, formatClock } from './time.ts';

interface ControlsProps {
  readonly playing: boolean;
  readonly currentSeconds: number;
  /** NaN until the browser has read the file's metadata. */
  readonly durationSeconds: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly fullscreen: boolean;
  readonly onToggle: () => void;
  readonly onSkip: (seconds: number) => void;
  /** An absolute time, from dragging the bar. */
  readonly onSeek: (seconds: number) => void;
  readonly onVolume: (volume: number) => void;
  readonly onMute: () => void;
  readonly onFullscreen: () => void;
}

/**
 * The player's controls, drawn here rather than left to the browser: the room
 * will want them laid out its own way, and a native control bar cannot be
 * driven from the keyboard shortcuts or a remote queue.
 *
 * Every state it shows comes down from the element, so it holds none of its
 * own and cannot drift out of step with what is playing.
 */
export function Controls({
  playing,
  currentSeconds,
  durationSeconds,
  volume,
  muted,
  fullscreen,
  onToggle,
  onSkip,
  onSeek,
  onVolume,
  onMute,
  onFullscreen,
}: ControlsProps) {
  const known = Number.isFinite(durationSeconds) && durationSeconds > 0;

  return (
    <div className="controls">
      <div className="bar">
        <span className="clock">{formatClock(currentSeconds)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={known ? durationSeconds : 0}
          step={0.1}
          value={Math.min(currentSeconds, known ? durationSeconds : 0)}
          disabled={!known}
          aria-label="seek"
          onChange={(event) => {
            onSeek(event.currentTarget.valueAsNumber);
          }}
        />
        <span className="clock">{formatClock(durationSeconds)}</span>
      </div>

      <div className="buttons">
        <button
          type="button"
          aria-label={`back ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            onSkip(-SKIP_SECONDS);
          }}
        >
          -{SKIP_SECONDS}s
        </button>
        <button type="button" className="play" aria-label={playing ? 'pause' : 'play'} onClick={onToggle}>
          {playing ? 'pause' : 'play'}
        </button>
        <button
          type="button"
          aria-label={`forward ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            onSkip(SKIP_SECONDS);
          }}
        >
          +{SKIP_SECONDS}s
        </button>

        <span className="spacer" />

        <button type="button" aria-label={muted ? 'unmute' : 'mute'} onClick={onMute}>
          {muted || volume === 0 ? 'muted' : 'sound'}
        </button>
        <input
          className="volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="volume"
          onChange={(event) => {
            onVolume(event.currentTarget.valueAsNumber);
          }}
        />
        <button type="button" onClick={onFullscreen}>
          {fullscreen ? 'leave fullscreen' : 'fullscreen'}
        </button>
      </div>

      <p className="note">
        Space plays and pauses, the left and right arrows skip {SKIP_SECONDS} seconds, up and down
        change the volume, m mutes and f fills the screen.
      </p>
    </div>
  );
}
