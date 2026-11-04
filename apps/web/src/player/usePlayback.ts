import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  sourceKindFor,
  titleFromFileName,
  type SongRecord,
  type SourceKind,
} from '../library/songs.ts';
import { playableSource } from '../library/storage.ts';
import { analysisKeyFor } from '../separation/queue.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';

/**
 * What is on the stage, and the object URL it plays from.
 *
 * A file somebody has just handed over is played from its own bytes, straight
 * away: no decode, no copy into the filesystem, nothing to wait for. The
 * record and the stems catch up in the background, and `identify` is how the
 * stage learns which record turned out to be its own.
 *
 * A song reopened later is played from the copy kept in OPFS. Either way the
 * URL holds the file open for as long as it exists, so there is exactly one
 * at a time and it is revoked the moment it is replaced.
 */

export interface Staged {
  readonly title: string;
  readonly sourceKind: SourceKind;
  /**
   * The file to play. Null while it is being opened, and for a song added
   * before audio sources were kept, which has nothing but stems.
   */
  readonly url: string | null;
  /** The key the file was queued for analysis under, when it was picked here. */
  readonly key: string | null;
  readonly songId: string | null;
}

export interface Playback {
  readonly staged: Staged | null;
  readonly opening: boolean;
  readonly error: string | null;
  /** Plays a picked file at once, from the bytes the person just handed over. */
  openFile(file: File): void;
  /** Plays a song already in the library, from the file kept with it. */
  openSong(song: SongRecord): void;
  /**
   * Ties the staged file to the record that turned out to be its own. False
   * when something else has since taken the stage.
   */
  identify(key: string, songId: string): boolean;
  clear(): void;
}

export function usePlayback(): Playback {
  const store = useMemo(() => createOpfsStore(), []);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The same thing where it can be read without waiting for a render. */
  const held = useRef<Staged | null>(null);
  const url = useRef<string | null>(null);

  const put = useCallback((next: Staged | null): void => {
    held.current = next;
    setStaged(next);
  }, []);

  const release = useCallback((): void => {
    if (url.current !== null) {
      URL.revokeObjectURL(url.current);
      url.current = null;
    }
  }, []);

  const openFile = useCallback(
    (file: File): void => {
      release();
      setError(null);
      setOpening(false);
      const made = URL.createObjectURL(file);
      url.current = made;
      put({
        title: titleFromFileName(file.name),
        sourceKind: sourceKindFor(file.name, file.type),
        url: made,
        key: analysisKeyFor(file.name, file.size, file.lastModified),
        songId: null,
      });
    },
    [put, release],
  );

  const openSong = useCallback(
    (song: SongRecord): void => {
      // The library's records are read again on every refresh, so the same
      // song arrives here many times over. Only a different one is a change.
      if (held.current?.songId === song.id) {
        return;
      }
      release();
      setError(null);
      put({
        title: song.title,
        sourceKind: song.sourceKind,
        url: null,
        key: null,
        songId: song.id,
      });

      const path = song.sourcePath;
      if (path === null) {
        // Nothing was kept: its stems are the song, on a stage of their own.
        setOpening(false);
        return;
      }
      setOpening(true);

      void (async () => {
        try {
          const blob = await playableSource(store, path, song.sourceKind);
          const current = held.current;
          if (current === null || current.songId !== song.id) {
            return;
          }
          const made = URL.createObjectURL(blob);
          url.current = made;
          put({ ...current, url: made });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setOpening(false);
        }
      })();
    },
    [put, release, store],
  );

  const identify = useCallback(
    (key: string, songId: string): boolean => {
      const current = held.current;
      if (current === null || current.key !== key) {
        return false;
      }
      put({ ...current, songId });
      return true;
    },
    [put],
  );

  const clear = useCallback((): void => {
    release();
    setError(null);
    setOpening(false);
    put(null);
  }, [put, release]);

  useEffect(
    // The URL holds the file open for as long as it exists, so closing the
    // tab has to let go of it.
    () => () => {
      release();
    },
    [release],
  );

  return useMemo(
    () => ({ staged, opening, error, openFile, openSong, identify, clear }),
    [clear, error, identify, openFile, openSong, opening, staged],
  );
}
