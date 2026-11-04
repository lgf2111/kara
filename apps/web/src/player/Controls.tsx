import {
  Maximize,
  Minimize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { Slider } from '@/components/ui/slider';
import { sliderNumber } from '@/lib/slider-value';
import { ControlAction } from './ControlAction.tsx';
import { LyricsButton } from './LyricsButton.tsx';
import { SKIP_SECONDS, formatClock } from './time.ts';
import type { LyricsRead } from './lyrics-read.ts';
import type { Transport } from './transport.ts';
import type { StageLyrics } from './useStageLyrics.ts';

interface ControlsProps {
  readonly transport: Transport;
  /** The words for this song, and whether they are on. */
  readonly lyrics: StageLyrics;
  /** Reading them off the picture, for a song that has none yet. */
  readonly read: LyricsRead;
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
export function Controls({ transport, lyrics, read }: ControlsProps) {
  const { currentSeconds, durationSeconds, muted, volume } = transport;
  const known = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const at = known ? Math.min(currentSeconds, durationSeconds) : 0;
  const silent = muted || volume === 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="flex-none text-xs tabular-nums text-white/60">
          {formatClock(currentSeconds)}
        </span>
        {/*
          Sized by a wrapper rather than on the slider: the slider asks for the
          full width of whatever holds it, which is what a seek bar wants and
          what the two short sliders have to be told otherwise.
        */}
        <div className="min-w-20 flex-1">
          <Slider
            thumbLabel="seek"
            min={0}
            max={known ? durationSeconds : 1}
            step={0.1}
            value={[at]}
            disabled={!known}
            onValueChange={(next) => {
              transport.seek(sliderNumber(next));
            }}
          />
        </div>
        <span className="flex-none text-xs tabular-nums text-white/60">
          {formatClock(durationSeconds)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <ControlAction
          label={transport.playing ? 'pause' : 'play'}
          onClick={() => {
            transport.toggle();
          }}
        >
          {transport.playing ? (
            <Pause className="size-5" aria-hidden="true" />
          ) : (
            <Play className="size-5" aria-hidden="true" />
          )}
        </ControlAction>
        <ControlAction
          label={`back ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            transport.skip(-SKIP_SECONDS);
          }}
        >
          <SkipBack aria-hidden="true" />
        </ControlAction>
        <ControlAction
          label={`forward ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            transport.skip(SKIP_SECONDS);
          }}
        >
          <SkipForward aria-hidden="true" />
        </ControlAction>
        {/* Nothing at all for a song with no words and no way to get any. */}
        <LyricsButton lyrics={lyrics} read={read} />

        <span className="flex-1" />

        <ControlAction
          label={muted ? 'unmute' : 'mute'}
          onClick={() => {
            transport.toggleMute();
          }}
        >
          {silent ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </ControlAction>
        <div className="w-20 flex-none sm:w-28">
          <Slider
            thumbLabel="volume"
            min={0}
            max={1}
            step={0.05}
            value={[muted ? 0 : volume]}
            onValueChange={(next) => {
              transport.setVolume(sliderNumber(next));
            }}
          />
        </div>
        <ControlAction
          label={transport.fullscreen ? 'leave fullscreen' : 'fullscreen'}
          onClick={() => {
            transport.toggleFullscreen();
          }}
        >
          {transport.fullscreen ? (
            <Minimize aria-hidden="true" />
          ) : (
            <Maximize aria-hidden="true" />
          )}
        </ControlAction>
      </div>
    </div>
  );
}
