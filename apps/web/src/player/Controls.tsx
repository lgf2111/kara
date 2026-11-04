import type { ReactNode } from 'react';
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

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { sliderNumber } from '@/lib/slider-value';
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

interface ActionProps {
  /** Both the tooltip and the accessible name: one label, said once. */
  readonly label: string;
  readonly children: ReactNode;
  readonly onClick: () => void;
}

/** An icon and its name, which a room on a phone reaches for with a thumb. */
function Action({ label, children, onClick }: ActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={label}
            className="size-11 text-white/85 hover:bg-white/10 hover:text-white sm:size-10"
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Controls({ transport }: ControlsProps) {
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
        <Slider
          className="min-w-20 flex-1"
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
        <span className="flex-none text-xs tabular-nums text-white/60">
          {formatClock(durationSeconds)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <Action
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
        </Action>
        <Action
          label={`back ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            transport.skip(-SKIP_SECONDS);
          }}
        >
          <SkipBack aria-hidden="true" />
        </Action>
        <Action
          label={`forward ${String(SKIP_SECONDS)} seconds`}
          onClick={() => {
            transport.skip(SKIP_SECONDS);
          }}
        >
          <SkipForward aria-hidden="true" />
        </Action>

        <span className="flex-1" />

        <Action
          label={muted ? 'unmute' : 'mute'}
          onClick={() => {
            transport.toggleMute();
          }}
        >
          {silent ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </Action>
        <Slider
          className="w-20 flex-none sm:w-28"
          thumbLabel="volume"
          min={0}
          max={1}
          step={0.05}
          value={[muted ? 0 : volume]}
          onValueChange={(next) => {
            transport.setVolume(sliderNumber(next));
          }}
        />
        <Action
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
        </Action>
      </div>
    </div>
  );
}
