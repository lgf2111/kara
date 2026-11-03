import { describeStatus, formatBytes, formatDuration } from './format.ts';
import type { SongRecord } from './songs.ts';

interface SongListProps {
  readonly songs: readonly SongRecord[];
  /** Bytes each song occupies in OPFS, keyed by song id. */
  readonly sizes: ReadonlyMap<string, number>;
  /** A song being worked on cannot be deleted: the worker holds its files. */
  readonly busy: boolean;
  readonly onDelete: (song: SongRecord) => void;
}

export function SongList({ songs, sizes, busy, onDelete }: SongListProps) {
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
          </div>
          <button
            type="button"
            disabled={busy && song.status === 'separating'}
            onClick={() => {
              onDelete(song);
            }}
          >
            delete
          </button>
        </li>
      ))}
    </ul>
  );
}
