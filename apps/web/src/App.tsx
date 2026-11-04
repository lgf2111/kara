import { useEffect, useState } from 'react';

import { Drawer } from './library/Drawer.tsx';
import type { SongRecord } from './library/songs.ts';
import { useLibrary } from './library/useLibrary.ts';
import { Stage } from './player/Stage.tsx';
import { stageAnalysis } from './player/analysis.ts';
import { ORIGINAL_CHOICE, type VocalChoice } from './player/stem-mix.ts';
import { usePlayback } from './player/usePlayback.ts';
import { useSongRoute } from './player/useSongRoute.ts';

/**
 * Kara is a player with a library behind it, not a library with a player in
 * it. The window is the stage: a song goes on the moment its file is in, and
 * the list, the storage figures and the lyrics are all in a drawer over the
 * top of it that shuts again.
 */
export function App() {
  const library = useLibrary();
  const route = useSongRoute();
  const playback = usePlayback();
  // Above the song, so putting the next one on keeps the choice. A room sets
  // this once an evening, not once a song.
  const [vocals, setVocals] = useState<VocalChoice>(ORIGINAL_CHOICE);
  const [drawer, setDrawer] = useState(false);

  const staged = playback.staged;
  const stagedId = staged === null ? null : staged.songId;
  const stagedSong =
    stagedId === null ? null : (library.songs.find((song) => song.id === stagedId) ?? null);

  // The hash is what survives a reload, so it decides which song is on unless
  // somebody has just handed over a file, which has no record to name yet.
  const routeSong =
    route.songId === null
      ? null
      : (library.songs.find((song) => song.id === route.songId) ?? null);
  const openSong = playback.openSong;
  useEffect(() => {
    if (routeSong !== null) {
      openSong(routeSong);
    }
  }, [openSong, routeSong]);

  const openFiles = (files: readonly File[]): void => {
    const first = files[0];
    if (first === undefined) {
      return;
    }
    // Whatever the hash named, it is not this.
    route.clear();
    playback.openFile(first);
    // Analysis of all of them, in the order they arrived, one at a time.
    for (const file of files) {
      library.add(file, (song, key) => {
        // Only the one on the stage names itself in the address bar.
        if (playback.identify(key, song.id)) {
          route.openPlayer(song.id);
        }
      });
    }
    setDrawer(false);
  };

  const askThenDelete = (song: SongRecord): void => {
    if (!confirm(`Delete ${song.title}? Its stems and anything kept with them go with it.`)) {
      return;
    }
    if (stagedId === song.id) {
      playback.clear();
      route.clear();
    }
    library.remove(song);
  };

  const askThenRemoveLyrics = (song: SongRecord): void => {
    if (confirm(`Remove the lyrics read for ${song.title}? Reading them again takes minutes.`)) {
      library.removeLyrics(song);
    }
  };

  const analysis = stageAnalysis({
    status: stagedSong === null ? null : stagedSong.status,
    job: library.active,
    queue: library.queue,
    key: staged === null ? null : staged.key,
    songId: stagedId,
  });
  const resumeKey =
    staged === null ? null : library.resumeKeyFor(staged.key, staged.songId);
  const resumable = analysis.phase === 'paused' || analysis.phase === 'failed';

  return (
    <>
      <main className="fixed inset-0 overflow-hidden bg-black">
        <Stage
          staged={staged}
          song={stagedSong}
          opening={playback.opening}
          error={playback.error}
          analysis={analysis}
          vocals={vocals}
          onVocals={setVocals}
          onFiles={openFiles}
          onOpenDrawer={() => {
            setDrawer(true);
          }}
          shortcuts={!drawer}
          onCancelAnalysis={analysis.phase === 'running' ? library.cancel : null}
          onResumeAnalysis={
            resumable && resumeKey !== null
              ? () => {
                  library.resume(resumeKey);
                }
              : null
          }
        />
      </main>

      <Drawer
        open={drawer}
        library={library}
        onClose={() => {
          setDrawer(false);
        }}
        onPlay={(song) => {
          setDrawer(false);
          route.openPlayer(song.id);
        }}
        onFiles={openFiles}
        onDelete={askThenDelete}
        onRemoveLyrics={askThenRemoveLyrics}
      />
    </>
  );
}
