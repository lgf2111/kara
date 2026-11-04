import { Film, HardDrive, Music, Play, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LyricsActions } from './LyricsActions.tsx';
import { describeStatus, formatBytes, formatDuration } from './format.ts';
import { canPlay, type SongRecord, type SongStatus } from './songs.ts';
import type { LyricsJob } from './useLibrary.ts';

interface SongListProps {
  readonly songs: readonly SongRecord[];
  /** Bytes each song occupies in OPFS, keyed by song id. */
  readonly sizes: ReadonlyMap<string, number>;
  /** A song being worked on cannot be deleted: the worker holds its files. */
  readonly busy: boolean;
  /** The lyric read in flight, on whichever song it belongs to. */
  readonly lyricsJob: LyricsJob | null;
  readonly cancellingLyrics: boolean;
  readonly onPlay: (song: SongRecord) => void;
  readonly onDelete: (song: SongRecord) => void;
  readonly onReadLyrics: (song: SongRecord) => void;
  readonly onCancelLyrics: () => void;
  readonly onRemoveLyrics: (song: SongRecord) => void;
}

/** How a status reads at a glance, before the words beside it are read. */
function statusTone(status: SongStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'ready':
      return 'secondary';
    case 'separating':
      return 'default';
    case 'cancelled':
      return 'outline';
    case 'failed':
      return 'destructive';
  }
}

export function SongList({
  songs,
  sizes,
  busy,
  lyricsJob,
  cancellingLyrics,
  onPlay,
  onDelete,
  onReadLyrics,
  onCancelLyrics,
  onRemoveLyrics,
}: SongListProps) {
  if (songs.length === 0) {
    return <p className="text-sm text-muted-foreground">No songs yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {songs.map((song) => {
        const reading = lyricsJob?.songId === song.id;
        const Kind = song.sourceKind === 'video' ? Film : Music;

        return (
          <li
            key={song.id}
            className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{song.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="tabular-nums">{formatDuration(song.durationMs)}</span>
                  <Badge variant={statusTone(song.status)}>{describeStatus(song.status)}</Badge>
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="size-3" aria-hidden="true" />
                    {formatBytes(sizes.get(song.id) ?? 0)} on this device
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kind className="size-3" aria-hidden="true" />
                    {formatBytes(song.sourceBytes)}{' '}
                    {song.sourcePath === null ? 'file, stems only' : 'file, kept as it arrived'}
                  </span>
                </p>
              </div>

              <div className="flex flex-none items-center gap-1">
                {/* A kept file plays as it stands; stems play on a stage of their own. */}
                {canPlay(song) && (
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label={`play ${song.title}`}
                    onClick={() => {
                      onPlay(song);
                    }}
                  >
                    <Play aria-hidden="true" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`delete ${song.title}`}
                  className="text-muted-foreground hover:text-destructive"
                  // Whatever is holding this song's files holds them open.
                  disabled={(busy && song.status === 'separating') || reading}
                  onClick={() => {
                    onDelete(song);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            </div>

            <LyricsActions
              song={song}
              job={reading ? lyricsJob : null}
              cancelling={cancellingLyrics}
              busy={busy || lyricsJob !== null}
              onRead={onReadLyrics}
              onCancel={onCancelLyrics}
              onRemove={onRemoveLyrics}
            />
          </li>
        );
      })}
    </ul>
  );
}
