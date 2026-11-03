import { useEffect, useMemo, useState } from 'react';

import { formatDuration } from '../library/format.ts';
import type { SongRecord } from '../library/songs.ts';
import { playableSource } from '../library/storage.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';
import { AudioStage } from './AudioStage.tsx';
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
 * A video plays as it stands, so it works the moment the file is in: before
 * separation has finished, and for a song whose separation was cancelled or
 * failed. Once the stems exist they play against the same picture in place of
 * its own sound.
 *
 * A song that came in as audio kept no file: only a video's own bytes are
 * worth keeping for the room. Its stems are the only copy of it this device
 * holds, so it plays them, on a stage of its own, once they are there.
 */
export function Player({ song, onBack, vocals, onVocals }: PlayerProps) {
  const store = useMemo(() => createOpfsStore(), []);
  const path = song.sourcePath;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** No file of its own, but separated: the stems are the song. */
  const fromStems = path === null && song.status === 'ready';

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

      {path === null && !fromStems && (
        <p className="note">
          Nothing to play for this one yet. Its picture was never kept: only a video keeps its own
          bytes, and this song came in as audio. Its stems are the only copy of it here, and they
          are not finished.
        </p>
      )}

      {error !== null && <p className="error">{error}</p>}

      {path !== null && error === null && url === null && <p className="note">Opening the file…</p>}

      {url !== null && (
        <VideoStage url={url} song={song} vocals={vocals} onVocals={onVocals} />
      )}

      {fromStems && <AudioStage song={song} vocals={vocals} onVocals={onVocals} />}
    </main>
  );
}
