import { DropZone } from './library/DropZone.tsx';
import { SongList } from './library/SongList.tsx';
import { describeStage, describeStorage, formatBytes, formatEta } from './library/format.ts';
import type { SongRecord } from './library/songs.ts';
import { totalBytes } from './library/storage.ts';
import { useLibrary } from './library/useLibrary.ts';
import { Player } from './player/Player.tsx';
import { useSongRoute } from './player/useSongRoute.ts';

export function App() {
  const library = useLibrary();
  const route = useSongRoute();
  const active = library.active;
  const songCount = library.songs.length;
  const playing =
    route.songId === null ? null : (library.songs.find((song) => song.id === route.songId) ?? null);

  const askThenDelete = (song: SongRecord): void => {
    if (confirm(`Delete ${song.title}? Its stems and anything kept with them go with it.`)) {
      library.remove(song);
    }
  };

  const askThenRemoveLyrics = (song: SongRecord): void => {
    if (confirm(`Remove the lyrics read for ${song.title}? Reading them again takes minutes.`)) {
      library.removeLyrics(song);
    }
  };

  if (route.songId !== null) {
    // The list arrives a moment after the first render, and a hash typed in or
    // reloaded can name a song that has since been deleted.
    if (playing === null) {
      return (
        <main className="player">
          <button type="button" className="back" onClick={route.openLibrary}>
            back to the library
          </button>
          <p className="note">
            {library.loaded ? 'That song is not in this library.' : 'Looking for that song…'}
          </p>
        </main>
      );
    }
    return <Player song={playing} onBack={route.openLibrary} />;
  }

  return (
    <main className="library">
      <h1>Kara</h1>
      <p className="tagline">Upload a song you own. Get a KTV room.</p>

      <DropZone busy={active !== null || library.lyricsJob !== null} onFile={library.add} />

      {library.error !== null && (
        <section>
          <h2>That did not work</h2>
          <p className="error">{library.error}</p>
        </section>
      )}

      {active !== null && (
        <section>
          <h2>Working</h2>
          <p>
            {active.title}: {describeStage(active.stage)}
            {active.stage === 'separating' &&
              ` ${String(active.segmentsDone)} of ${String(active.segmentsTotal)} segments`}
            {active.resumedFrom > 0 && ` (carried on from segment ${String(active.resumedFrom)})`}
          </p>
          {active.stage === 'separating' && (
            <>
              <progress value={active.segmentsDone} max={Math.max(1, active.segmentsTotal)} />
              <p className="note">About {formatEta(active.etaMs)} left</p>
            </>
          )}
          <button type="button" disabled={library.cancelling} onClick={library.cancel}>
            {library.cancelling ? 'cancelling' : 'cancel'}
          </button>
          <p className="note">
            {library.cancelling
              ? 'Stopping after the segment it is on.'
              : 'Cancelling keeps what is done. Drop the same file again to carry on from there.'}
          </p>
        </section>
      )}

      <section>
        <h2>Songs</h2>
        <SongList
          songs={library.songs}
          sizes={library.sizes}
          busy={active !== null}
          lyricsJob={library.lyricsJob}
          cancellingLyrics={library.cancellingLyrics}
          onPlay={(song) => {
            route.openPlayer(song.id);
          }}
          onDelete={askThenDelete}
          onReadLyrics={library.readLyrics}
          onCancelLyrics={library.cancelLyrics}
          onRemoveLyrics={askThenRemoveLyrics}
        />
      </section>

      <section>
        <h2>Storage</h2>
        <p>
          {formatBytes(totalBytes(library.sizes))} across {String(songCount)}{' '}
          {songCount === 1 ? 'song' : 'songs'}, all of it on this device.
        </p>
        <p className="note">{describeStorage(library.usageBytes, library.quotaBytes)}</p>
      </section>

      <footer>
        <p className="note">
          Upload only, by design: there is no link import and no downloader. Your file is decoded
          and separated in this tab, and what you share with a friend holds timings and settings,
          never audio. Lyrics read off your own video stay on this device too.
        </p>
        <p className="note">
          Cross-origin isolation: <strong>{crossOriginIsolated ? 'on' : 'off'}</strong>. Separation
          needs it.
        </p>
      </footer>
    </main>
  );
}
