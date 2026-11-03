import { DropZone } from './library/DropZone.tsx';
import { SongList } from './library/SongList.tsx';
import { describeStage, describeStorage, formatBytes, formatEta } from './library/format.ts';
import type { SongRecord } from './library/songs.ts';
import { totalBytes } from './library/storage.ts';
import { useLibrary } from './library/useLibrary.ts';

export function App() {
  const library = useLibrary();
  const active = library.active;
  const songCount = library.songs.length;

  const askThenDelete = (song: SongRecord): void => {
    if (confirm(`Delete ${song.title}? Its stems and anything kept with them go with it.`)) {
      library.remove(song);
    }
  };

  return (
    <main className="library">
      <h1>Kara</h1>
      <p className="tagline">Upload a song you own. Get a KTV room.</p>

      <DropZone busy={active !== null} onFile={library.add} />

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
          onDelete={askThenDelete}
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
          never audio.
        </p>
        <p className="note">
          Cross-origin isolation: <strong>{crossOriginIsolated ? 'on' : 'off'}</strong>. Separation
          needs it.
        </p>
      </footer>
    </main>
  );
}
