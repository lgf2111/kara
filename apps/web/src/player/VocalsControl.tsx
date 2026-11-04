import { LoaderCircle, Mic, Music } from 'lucide-react';

import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { sliderNumber } from '@/lib/slider-value';
import { formatPercent } from '../library/format.ts';
import type { AnalysisView, VocalToggle } from './analysis.ts';
import type { VocalChoice } from './stem-mix.ts';

interface VocalsControlProps {
  /** Whether the voice can come out yet, and what to say while it cannot. */
  readonly toggle: VocalToggle;
  /** How far separation has got, which is what the waiting control shows. */
  readonly analysis: AnalysisView;
  readonly choice: VocalChoice;
  readonly onChoice: (choice: VocalChoice) => void;
}

/**
 * Whether the voice is in, and how much of it.
 *
 * Two things rather than one slider from nothing to everything: a room wants
 * the original for listening and the instrumental for singing, and the fader
 * is for the verse nobody is sure of.
 *
 * It is on the stage from the first second of the song, greyed, saying how
 * far analysis has got. A control that appears halfway through a song is a
 * control nobody finds.
 */
export function VocalsControl({ toggle, analysis, choice, onChoice }: VocalsControlProps) {
  const instrumental = choice.mode === 'instrumental';
  const waiting = !toggle.enabled;
  // Null while the worker has not counted the segments, and once separation
  // is done and only the reading off the disk is left.
  const share = waiting ? analysis.share : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-busy={waiting}>
      <span className="flex-none text-[0.7rem] font-medium tracking-[0.14em] text-white/50 uppercase">
        vocals
      </span>

      <ToggleGroup
        className="flex-none rounded-lg bg-white/5 p-0.5 ring-1 ring-white/10"
        variant="default"
        size="sm"
        spacing={0}
        disabled={waiting}
        value={[instrumental ? 'instrumental' : 'original']}
        onValueChange={(next) => {
          const picked = next[0];
          // Pressing the pressed one would otherwise leave the room with
          // neither, and a song has to be playing as something.
          if (picked === 'original' || picked === 'instrumental') {
            onChoice({ ...choice, mode: picked });
          }
        }}
      >
        <ToggleGroupItem
          value="original"
          className="px-2.5 text-white/70 aria-pressed:bg-white/15 aria-pressed:text-white"
        >
          <Mic aria-hidden="true" />
          original
        </ToggleGroupItem>
        <ToggleGroupItem
          value="instrumental"
          className="px-2.5 text-white/70 aria-pressed:bg-white/15 aria-pressed:text-white"
        >
          <Music aria-hidden="true" />
          instrumental
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="flex flex-none items-center gap-2">
        <span className="text-xs text-white/50">guide</span>
        <Slider
          className="w-20 sm:w-28"
          thumbLabel="guide vocal"
          min={0}
          max={100}
          step={5}
          value={[choice.guidePercent]}
          disabled={waiting || !instrumental}
          onValueChange={(next) => {
            onChoice({ ...choice, guidePercent: sliderNumber(next) });
          }}
        />
        <span className="min-w-10 text-xs tabular-nums text-white/50">
          {String(Math.round(choice.guidePercent))}%
        </span>
      </div>

      {waiting && (
        <div className="flex min-w-0 basis-full items-center gap-2 text-xs text-white/55">
          <LoaderCircle
            className="size-3.5 flex-none animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="truncate">{toggle.label}</span>
          {share !== null && (
            <>
              <Progress
                className="w-24 flex-none"
                value={Math.round(share * 100)}
                aria-label="analysis progress"
              />
              <span className="flex-none tabular-nums">{formatPercent(share)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
