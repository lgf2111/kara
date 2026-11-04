import { ChevronRight, FileText, LoaderCircle, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatDuration, formatEta } from './format.ts';
import { describeLyrics } from './lyrics-summary.ts';
import { canReadLyrics, type SongRecord } from './songs.ts';
import type { LyricsJob } from './useLibrary.ts';

interface LyricsActionsProps {
  readonly song: SongRecord;
  /** The read running on this song, or null when none is. */
  readonly job: LyricsJob | null;
  readonly cancelling: boolean;
  /** Something else holds the machine, so this song cannot start a read. */
  readonly busy: boolean;
  readonly onRead: (song: SongRecord) => void;
  readonly onCancel: () => void;
  readonly onRemove: (song: SongRecord) => void;
}

/**
 * One song's lyrics: read them off the video, watch it happen, or take them
 * away again. A song with no kept video has nothing to read, and shows
 * nothing.
 */
export function LyricsActions({
  song,
  job,
  cancelling,
  busy,
  onRead,
  onCancel,
  onRemove,
}: LyricsActionsProps) {
  if (job !== null) {
    return (
      <div className="space-y-1.5 border-t border-border/60 pt-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle
            className="size-3.5 flex-none animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">
            {job.stage}
            {job.framesTotal > 0 &&
              `: frame ${String(job.framesDone)} of ${String(job.framesTotal)}`}
            {job.etaMs !== null && `, about ${formatEta(job.etaMs)} left`}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={cancelling ? 'cancelling' : 'cancel reading the lyrics'}
            disabled={cancelling}
            onClick={onCancel}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <Progress
          value={Math.round((job.framesDone / Math.max(1, job.framesTotal)) * 100)}
          aria-label="lyric reading progress"
        />
      </div>
    );
  }

  const lyrics = song.lyrics;
  if (lyrics !== undefined) {
    return (
      <div className="border-t border-border/60 pt-2">
        {/*
          Shut until it is opened: the lines are the person's own reading of
          their own video, and a library of songs would be a wall of words.
          They are shown in this app and nowhere else.
        */}
        <details className="group/lyrics">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronRight
              className="size-3.5 flex-none transition-transform group-open/lyrics:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
            <FileText className="size-3.5 flex-none" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{describeLyrics(lyrics)}</span>
          </summary>

          <ol className="mt-2 max-h-72 space-y-0.5 overflow-y-auto border-l-2 border-border py-1 pl-3 text-xs">
            {lyrics.lines.map((line, index) => (
              <li
                key={`${String(line.startMs)}-${String(index)}`}
                className="flex gap-2.5 leading-relaxed"
              >
                <span className="flex-none text-muted-foreground tabular-nums">
                  {formatDuration(line.startMs)}
                </span>
                <span className="min-w-0">{line.text}</span>
              </li>
            ))}
          </ol>

          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Read from the video&rsquo;s own picture, kept on this device.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="flex-none text-muted-foreground hover:text-destructive"
              onClick={() => {
                onRemove(song);
              }}
            >
              <Trash2 aria-hidden="true" />
              remove lyrics
            </Button>
          </div>
        </details>
      </div>
    );
  }

  if (!canReadLyrics(song)) {
    return null;
  }

  return (
    <div className="border-t border-border/60 pt-2">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground"
        disabled={busy}
        onClick={() => {
          onRead(song);
        }}
      >
        <FileText aria-hidden="true" />
        read lyrics from the video
      </Button>
    </div>
  );
}
