import { useEffect, useMemo, useState } from 'react';

import { formatDuration } from '../library/format.ts';
import type { SongRecord } from '../library/songs.ts';
import { playableSource } from '../library/storage.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';
import { VideoStage } from './VideoStage.tsx';
import type { VocalChoice } from './stem-mix.ts';

interface PlayerProps {
  readonly song: SongRecord;
  readonly onBack: () => void;
  /** Held by the caller, so the room's choice outlives one song. */
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
}

/**
 * One song, playing from the file kept on this device.
 *
 * This plays the picked file as it stands, so it works the moment the file is
 * in: before separation has finished, and for a song whose separation was
 * cancelled or failed. Once the stems exist they play against the same
 * picture in place of its own sound.
 */
export function Player({ song, onBack, vocals, onVocals }: PlayerProps) {
  const store = useMemo(() => createOpfsStore(), []);
  const path = song.sourcePath;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (path === null) {
      return;
    }
    let dropped = false;
    let made: string | null = null;
    setError(null);

    void (async () => {
      try {
        const blob = await playableSource(store, path);
        if (dropped) {
          return;
        }
        made = URL.createObjectURL(blob);
        setUrl(made);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      // The URL holds the file open for as long as it exists, so leaving the
      // player has to let go of it.
      dropped = true;
      if (made !== null) {
        URL.revokeObjectURL(made);
      }
      setUrl(null);
    };
  }, [path, store]);

  return (
    <main className="player">
      <button type="button" className="back" onClick={onBack}>
        back to the library
      </button>

      <h1>{song.title}</h1>
      <p className="note">{formatDuration(song.durationMs)}, played from this device</p>

      {path === null && (
        <p className="note">
          Nothing to show for this one. Its picture was never kept: only a video keeps its own
          bytes, and this song came in as audio. Drop the video in and it will play here.
        </p>
      )}

      {error !== null && <p className="error">{error}</p>}

      {path !== null && error === null && url === null && <p className="note">Opening the file…</p>}

      {url !== null && (
        <VideoStage url={url} song={song} vocals={vocals} onVocals={onVocals} />
      )}
    </main>
  );
}
