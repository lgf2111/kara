import type { ReactNode } from 'react';
import { LoaderCircle, RotateCcw, Square, TriangleAlert, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatPercent } from '../library/format.ts';
import { describeAnalysis, type AnalysisPhase, type AnalysisView } from './analysis.ts';
import { describeLyricsRead, lyricsReadShare, type LyricsRead } from './lyrics-read.ts';

interface ProgressChipProps {
  readonly view: AnalysisView;
  /** The read running on this song, which takes the chip while it lasts. */
  readonly read: LyricsRead;
  /** The overlays have gone; the chip stays but gets out of the way. */
  readonly dim: boolean;
  readonly onCancel: (() => void) | null;
  /** Offered for a job this tab still holds the file for. */
  readonly onResume: (() => void) | null;
}

/**
 * What the machine is doing for this song, in one corner, while the song
 * plays over the top of it.
 *
 * It outlives the rest of the furniture. The bars go when the room settles,
 * but a separation runs for minutes and somebody will want to know whether it
 * is still going without waving at the screen, so this only dims.
 *
 * A lyric read takes the chip for as long as it lasts. The two cannot both be
 * going — the library runs one job at a time — and the one in flight is the
 * one worth a corner of somebody's video.
 */

/** The pill itself, which both jobs are reported in. */
function Chip({ dim, children }: { readonly dim: boolean; readonly children: ReactNode }) {
  return (
    <div
      className={cn(
        'absolute top-3 right-3 z-30 flex max-w-[min(26rem,calc(100%-1.5rem))] items-center gap-2 rounded-full border border-white/10 bg-black/70 py-1 pr-1 pl-3 text-xs text-white/75 shadow-lg backdrop-blur-md transition-opacity duration-200',
        dim && 'opacity-35',
      )}
      aria-live="polite"
    >
      {children}
    </div>
  );
}

function Spinner({ turning = true }: { readonly turning?: boolean }) {
  return (
    <LoaderCircle
      className={cn('size-3.5 flex-none', turning && 'animate-spin motion-reduce:animate-none')}
      aria-hidden="true"
    />
  );
}

function Share({ share, label }: { readonly share: number; readonly label: string }) {
  return (
    <>
      <Progress className="w-16 flex-none" value={Math.round(share * 100)} aria-label={label} />
      <span className="flex-none tabular-nums">{formatPercent(share)}</span>
    </>
  );
}

/** Still rather than spinning for a job that is only waiting its turn. */
function AnalysisIcon({ phase }: { readonly phase: AnalysisPhase }) {
  if (phase === 'failed') {
    return <TriangleAlert className="size-3.5 flex-none text-destructive" aria-hidden="true" />;
  }
  return <Spinner turning={phase === 'running'} />;
}

export function ProgressChip({ view, read, dim, onCancel, onResume }: ProgressChipProps) {
  const job = read.job;

  if (job !== null) {
    const share = lyricsReadShare(job);
    return (
      <Chip dim={dim}>
        <Spinner />
        <span className="truncate">{describeLyricsRead(job)}</span>
        {share !== null && <Share share={share} label="lyric reading progress" />}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={read.cancelling ? 'stopping' : 'stop reading the lyrics'}
          className="flex-none rounded-full text-white/70 hover:bg-white/10 hover:text-white"
          disabled={read.cancelling}
          onClick={read.cancel}
        >
          <X aria-hidden="true" />
        </Button>
      </Chip>
    );
  }

  if (view.phase === 'none' || view.phase === 'ready') {
    return null;
  }

  const share = view.share;

  return (
    <Chip dim={dim}>
      <AnalysisIcon phase={view.phase} />

      <span className="truncate">{describeAnalysis(view)}</span>

      {share !== null && <Share share={share} label="analysis progress" />}

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
    </Chip>
  );
}
