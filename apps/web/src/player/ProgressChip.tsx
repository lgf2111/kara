import { LoaderCircle, RotateCcw, Square, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatPercent } from '../library/format.ts';
import { describeAnalysis, type AnalysisView } from './analysis.ts';

interface ProgressChipProps {
  readonly view: AnalysisView;
  /** The overlays have gone; the chip stays but gets out of the way. */
  readonly dim: boolean;
  readonly onCancel: (() => void) | null;
  /** Offered for a job this tab still holds the file for. */
  readonly onResume: (() => void) | null;
}

/**
 * What analysis is doing, in one corner, while the song plays over the top of
 * it.
 *
 * It outlives the rest of the furniture. The bars go when the room settles,
 * but a separation runs for minutes and somebody will want to know whether it
 * is still going without waving at the screen, so this only dims.
 */
export function ProgressChip({ view, dim, onCancel, onResume }: ProgressChipProps) {
  if (view.phase === 'none' || view.phase === 'ready') {
    return null;
  }

  const share = view.share;
  const failed = view.phase === 'failed';

  return (
    <div
      className={cn(
        'absolute top-3 right-3 z-30 flex max-w-[min(26rem,calc(100%-1.5rem))] items-center gap-2 rounded-full border border-white/10 bg-black/70 py-1 pr-1 pl-3 text-xs text-white/75 shadow-lg backdrop-blur-md transition-opacity duration-200',
        dim && 'opacity-35',
      )}
      aria-live="polite"
    >
      {failed ? (
        <TriangleAlert className="size-3.5 flex-none text-destructive" aria-hidden="true" />
      ) : (
        <LoaderCircle
          className={cn(
            'size-3.5 flex-none',
            view.phase === 'running' && 'animate-spin motion-reduce:animate-none',
          )}
          aria-hidden="true"
        />
      )}

      <span className="truncate">{describeAnalysis(view)}</span>

      {share !== null && (
        <>
          <Progress
            className="w-16 flex-none"
            value={Math.round(share * 100)}
            aria-label="analysis progress"
          />
          <span className="flex-none tabular-nums">{formatPercent(share)}</span>
        </>
      )}

      {onCancel !== null && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="stop analysing"
          className="flex-none rounded-full text-white/70 hover:bg-white/10 hover:text-white"
          onClick={onCancel}
        >
          <Square aria-hidden="true" />
        </Button>
      )}

      {onResume !== null && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="carry on analysing"
          className="flex-none rounded-full text-white/70 hover:bg-white/10 hover:text-white"
          onClick={onResume}
        >
          <RotateCcw aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
