import { SKIP_SECONDS, formatClock } from './time.ts';
import type { Transport } from './transport.ts';

interface ControlsProps {
  readonly transport: Transport;
}

/**
 * The bar across the bottom of the stage, drawn here rather than left to the
 * browser: a native control bar cannot be driven from the keyboard shortcuts
 * or, later, from a remote queue, and it would sit on top of this one with
 * its own idea of what the keys do.
 *
 * Every state it shows comes from the transport, so it holds none of its own
 * and cannot drift out of step with what is playing.
 */
export function Controls({ transport }: ControlsProps) {
  const { currentSeconds, durationSeconds, muted, volume } = transport;
  const known = Number.isFinite(durationSeconds) && durationSeconds > 0;

  return (
    <div className="controls">
      <div className="seeking">
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
            transport.seek(event.currentTarget.valueAsNumber);
          }}
        />
        <span className="clock">{formatClock(durationSeconds)}</span>
      </div>

      <div className="buttons">
        <button
          type="button"
          className="play"
          aria-label={transport.playing ? 'pause' : 'play'}
          onClick={() => {
            transport.toggle();
          }}
        >
          {transport.playing ? 'pause' : 'play'}
        </button>
        <button
          type="button"
          aria-label={`back ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            transport.skip(-SKIP_SECONDS);
          }}
        >
          -{SKIP_SECONDS}s
        </button>
        <button
          type="button"
          aria-label={`forward ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            transport.skip(SKIP_SECONDS);
          }}
        >
          +{SKIP_SECONDS}s
        </button>

        <span className="spacer" />

        <button
          type="button"
          aria-label={muted ? 'unmute' : 'mute'}
          onClick={() => {
            transport.toggleMute();
          }}
        >
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
            transport.setVolume(event.currentTarget.valueAsNumber);
          }}
        />
        <button
          type="button"
          aria-label={transport.fullscreen ? 'leave fullscreen' : 'fullscreen'}
          onClick={() => {
            transport.toggleFullscreen();
          }}
        >
          {transport.fullscreen ? 'exit' : 'full'}
        </button>
      </div>
    </div>
  );
}
