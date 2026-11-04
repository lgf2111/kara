import { LoaderCircle, Square, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { describeStage, formatEta } from './format.ts';
import type { Library } from './useLibrary.ts';

interface QueuePanelProps {
  readonly library: Library;
}

/**
 * What is being analysed and what is behind it.
 *
 * The stage has a chip for the song it is playing; this is the whole machine:
 * the job that holds it, how far through it is, and the songs waiting their
 * turn. One at a time, because one separation already takes everything.
 */
export function QueuePanel({ library }: QueuePanelProps) {
  const active = library.active;
  const waiting = library.queue.waiting;
  if (active === null && waiting.length === 0) {
    return null;
  }

  const separating = active !== null && active.stage === 'separating';
  const total = active === null ? 1 : Math.max(1, active.segmentsTotal);

  return (
    <section className="space-y-3">
      <h2 className="text-[0.7rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
        Analysing
      </h2>

      {active !== null && (
        <div className="space-y-2 rounded-xl border border-border/60 bg-muted/30 p-3">
          <div className="flex items-start gap-2">
            <LoaderCircle
              className="mt-0.5 size-4 flex-none animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{active.title}</p>
              <p className="text-xs text-muted-foreground">
                {describeStage(active.stage)}
                {separating &&
                  ` · ${String(active.segmentsDone)} of ${String(active.segmentsTotal)} segments`}
                {active.resumedFrom > 0 &&
                  ` · carried on from segment ${String(active.resumedFrom)}`}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={library.cancelling ? 'stopping' : 'stop analysing'}
              disabled={library.cancelling}
              onClick={library.cancel}
            >
              <Square aria-hidden="true" />
            </Button>
          </div>

          {separating && (
            <>
              <Progress
                value={Math.round((active.segmentsDone / total) * 100)}
                aria-label="separation progress"
              />
              <p className="text-xs text-muted-foreground">
                About {formatEta(active.etaMs)} left
              </p>
            </>
          )}

          <p className="text-xs text-muted-foreground">
            {library.cancelling
              ? 'Stopping after the segment it is on.'
              : 'Stopping keeps what is done. Resume it from the chip on the stage, or drop the same file in again.'}
          </p>
        </div>
      )}

      {waiting.length > 0 && (
        <ul className="space-y-1">
          {waiting.map((item, index) => (
            <li key={item.key} className="flex items-center gap-2 text-sm">
              <Badge variant="outline" className="flex-none tabular-nums">
                {index + 1}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`take ${item.title} out of the queue`}
                onClick={() => {
                  library.forget(item.key);
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
