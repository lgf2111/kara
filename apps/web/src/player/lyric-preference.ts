/**
 * Whether a song's words are laid over it, remembered for each song.
 *
 * Per song rather than for the room, because the answer depends on the file:
 * most of these are lyric videos with the words already in the picture, where
 * a second set over the top is worse than none, and some are plain video or
 * audio where the overlay is the only way to read along. So it is off until
 * somebody turns it on for that song, and then it stays on for that song.
 *
 * Nothing here can fail. A browser with storage switched off, a private
 * window, or a quota that has run out all throw on these calls, and none of
 * that is worth a word on screen: the choice still holds for as long as the
 * song is on, it simply is not there next time.
 */

const PREFIX = 'kara.lyrics.';

/** The remembered choice, or null when there is none for this song. */
export function readLyricChoice(songId: string): boolean | null {
  try {
    const kept = localStorage.getItem(PREFIX + songId);
    return kept === null ? null : kept === 'on';
  } catch {
    // No storage to read. Treated as nothing remembered.
    return null;
  }
}

export function writeLyricChoice(songId: string, on: boolean): void {
  try {
    localStorage.setItem(PREFIX + songId, on ? 'on' : 'off');
  } catch {
    // Nowhere to keep it. The choice still applies to the song playing.
  }
}
