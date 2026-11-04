import { useCallback, useEffect, useMemo, useState } from 'react';

import type { LyricLine, SongRecord } from '../library/songs.ts';
import { readLyricChoice, writeLyricChoice } from './lyric-preference.ts';

/**
 * The words for whatever is on the stage, and whether they are showing.
 *
 * The lines come off the record, so a read that finishes while the song is
 * playing puts the toggle on the bar without anything being reopened. The
 * choice comes out of {@link readLyricChoice}, which means off for a song
 * nobody has decided about.
 *
 * A file just handed over has no record for a second or two. It has no lines
 * either, so there is nothing to show and nothing to remember until the
 * record arrives, and then this reads it like any other.
 */

export interface StageLyrics {
  /** The lines to lay over the song, or null when this song has none. */
  readonly lines: readonly LyricLine[] | null;
  /** Whether they are being shown. False whenever there are none. */
  readonly on: boolean;
  toggle(): void;
}

export function useStageLyrics(song: SongRecord | null): StageLyrics {
  const songId = song?.id ?? null;
  const found = song?.lyrics?.lines ?? null;
  // An empty list is the same as no lyrics: a read that came back with
  // nothing should not put a switch on the bar that does nothing.
  const lines = found !== null && found.length > 0 ? found : null;
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(songId === null ? false : (readLyricChoice(songId) ?? false));
  }, [songId]);

  const toggle = useCallback((): void => {
    const next = !on;
    setOn(next);
    if (songId !== null) {
      writeLyricChoice(songId, next);
    }
  }, [on, songId]);

  return useMemo(
    () => ({ lines, on: lines !== null && on, toggle }),
    [lines, on, toggle],
  );
}
