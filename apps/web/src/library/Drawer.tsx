import { SKIP_SECONDS } from '../player/time.ts';
import { DropZone } from './DropZone.tsx';
import { SongList } from './SongList.tsx';
import { describeStage, describeStorage, formatBytes, formatEta } from './format.ts';
import type { SongRecord } from './songs.ts';
import { totalBytes } from './storage.ts';
import type { Library } from './useLibrary.ts';

interface DrawerProps {
  readonly open: boolean;
  readonly library: Library;
  readonly onClose: () => void;
  readonly onPlay: (song: SongRecord) => void;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onDelete: (song: SongRecord) => void;
  readonly onRemoveLyrics: (song: SongRecord) => void;
}

/**
 * The library, over the stage rather than instead of it.
 *
 * A song is still playing behind this, which is the point: putting the next
 * one on, reading lyrics off one, or seeing what the device is holding should
 * not stop the room. It slides over, does its job and goes away.
 */
export function Drawer({
  open,
  library,
  onClose,
  onPlay,
  onFiles,
  onDelete,
  onRemoveLyrics,
}: DrawerProps) {
  const active = library.active;
  const waiting = library.queue.waiting;
  const songCount = library.songs.length;

  return (
    <div className={open ? 'drawer open' : 'drawer'} aria-hidden={!open}>
      {/* Tapping the song behind is how a drawer is usually shut. */}
      <button type="button" className="scrim" aria-label="close the songs" onClick={onClose} />

      <aside className="panel">
        <header>
          <h1>Kara</h1>
          <button type="button" className="close" onClick={onClose}>
            close
          </button>
        </header>

        <DropZone
          heading="Drop another song you own, or choose a file."
          onFiles={(files) => {
            onFiles(files);
          }}
        />

        {library.notice !== null && (
          <section>
            <h2>Worth knowing</h2>
            <p className="note">{library.notice}</p>
            <button type="button" onClick={library.dismissNotice}>
              dismiss
            </button>
          </section>
        )}

        {library.error !== null && (
          <section>
            <h2>That did not work</h2>
            <p className="error">{library.error}</p>
            <button type="button" onClick={library.dismissError}>
              dismiss
            </button>
          </section>
        )}

        {(active !== null || waiting.length > 0) && (
          <section>
            <h2>Analysing</h2>
            {active !== null && (
              <>
                <p>
                  {active.title}: {describeStage(active.stage)}
                  {active.stage === 'separating' &&
                    ` ${String(active.segmentsDone)} of ${String(active.segmentsTotal)} segments`}
                  {active.resumedFrom > 0 &&
                    ` (carried on from segment ${String(active.resumedFrom)})`}
                </p>
                {active.stage === 'separating' && (
                  <>
                    <progress
                      value={active.segmentsDone}
                      max={Math.max(1, active.segmentsTotal)}
                    />
                    <p className="note">About {formatEta(active.etaMs)} left</p>
                  </>
                )}
                <button type="button" disabled={library.cancelling} onClick={library.cancel}>
                  {library.cancelling ? 'stopping' : 'stop'}
                </button>
                <p className="note">
                  {library.cancelling
                    ? 'Stopping after the segment it is on.'
                    : 'Stopping keeps what is done. Resume it from the chip on the stage, or drop the same file in again.'}
                </p>
              </>
            )}
            {waiting.length > 0 && (
              <ul className="queue">
                {waiting.map((item, index) => (
                  <li key={item.key}>
                    <span className="place">{index + 1}</span>
                    <span className="said">{item.title}</span>
                    <button
                      type="button"
                      onClick={() => {
                        library.forget(item.key);
                      }}
                    >
                      take out
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
            onPlay={onPlay}
            onDelete={onDelete}
            onReadLyrics={library.readLyrics}
            onCancelLyrics={library.cancelLyrics}
            onRemoveLyrics={onRemoveLyrics}
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
            Space plays and pauses, the left and right arrows skip {SKIP_SECONDS} seconds, up and
            down change the volume, m mutes and f fills the screen.
          </p>
          <p className="note">
            Upload only, by design: there is no link import and no downloader. Your file is decoded
            and separated in this tab, and what you share with a friend holds timings and settings,
            never audio. Lyrics read off your own video stay on this device too.
          </p>
          <p className="note">
            Cross-origin isolation: <strong>{crossOriginIsolated ? 'on' : 'off'}</strong>.
            Separation needs it.
          </p>
        </footer>
      </aside>
    </div>
  );
}
