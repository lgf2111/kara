import { formatEta } from './format.ts';
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
      <div className="lyrics">
        <p className="note">
          {job.stage}
          {job.framesTotal > 0 &&
            `: frame ${String(job.framesDone)} of ${String(job.framesTotal)}`}
          {job.etaMs !== null && `, about ${formatEta(job.etaMs)} left`}
        </p>
        <progress value={job.framesDone} max={Math.max(1, job.framesTotal)} />
        <button type="button" disabled={cancelling} onClick={onCancel}>
          {cancelling ? 'cancelling' : 'cancel'}
        </button>
      </div>
    );
  }

  const lyrics = song.lyrics;
  if (lyrics !== undefined) {
    return (
      <div className="lyrics">
        <p className="note">
          {String(lyrics.lines.length)} lyric {lyrics.lines.length === 1 ? 'line' : 'lines'} read
          from the video, kept on this device.
        </p>
        <button
          type="button"
          onClick={() => {
            onRemove(song);
          }}
        >
          remove lyrics
        </button>
      </div>
    );
  }

  if (!canReadLyrics(song)) {
    return null;
  }
  return (
    <div className="lyrics">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          onRead(song);
        }}
      >
        read lyrics from the video
      </button>
    </div>
  );
}
