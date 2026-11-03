import { LyricsActions } from './LyricsActions.tsx';
import { describeStatus, formatBytes, formatDuration } from './format.ts';
import type { SongRecord } from './songs.ts';
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
    return <p className="note">No songs yet.</p>;
  }

  return (
    <ul className="songs">
      {songs.map((song) => (
        <li key={song.id}>
          <div>
            <p className="song-title">{song.title}</p>
            <p className="song-meta">
              {formatDuration(song.durationMs)} · {describeStatus(song.status)} ·{' '}
              {formatBytes(sizes.get(song.id) ?? 0)} of stems · {formatBytes(song.sourceBytes)}{' '}
              {song.sourceKind} file
              {song.sourcePath === null ? '' : ', kept as the background'}
            </p>
            <LyricsActions
              song={song}
              job={lyricsJob?.songId === song.id ? lyricsJob : null}
              cancelling={cancellingLyrics}
              busy={busy || lyricsJob !== null}
              onRead={onReadLyrics}
              onCancel={onCancelLyrics}
              onRemove={onRemoveLyrics}
            />
          </div>
          <div className="song-actions">
            {/* The kept picture plays on its own, whatever the stems are doing. */}
            {song.sourcePath !== null && (
              <button
                type="button"
                onClick={() => {
                  onPlay(song);
                }}
              >
                play
              </button>
            )}
            <button
              type="button"
              // Whatever is holding this song's files holds them open.
              disabled={(busy && song.status === 'separating') || lyricsJob?.songId === song.id}
              onClick={() => {
                onDelete(song);
              }}
            >
              delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
