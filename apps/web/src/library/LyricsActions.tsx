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
        {/*
          Shut until it is opened: the lines are the person's own reading of
          their own video, and a library of songs would be a wall of words.
          They are shown in this app and nowhere else.
        */}
        <details className="lyric-lines">
          <summary>{describeLyrics(lyrics)}</summary>
          <ol>
            {lyrics.lines.map((line, index) => (
              <li key={`${String(line.startMs)}-${String(index)}`}>
                <span className="at">{formatDuration(line.startMs)}</span>
                <span className="said">{line.text}</span>
              </li>
            ))}
          </ol>
          <p className="note">Read from the video's own picture, kept on this device.</p>
        </details>
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
