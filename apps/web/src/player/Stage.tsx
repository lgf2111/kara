import { DropZone } from '../library/DropZone.tsx';
import type { SongRecord } from '../library/songs.ts';
import { MediaStage } from './MediaStage.tsx';
import { StemStage } from './StemStage.tsx';
import type { AnalysisView } from './analysis.ts';
import type { VocalChoice } from './stem-mix.ts';
import type { Staged } from './usePlayback.ts';

interface StageProps {
  readonly staged: Staged | null;
  /** The record for the staged song, once there is one. */
  readonly song: SongRecord | null;
  readonly opening: boolean;
  readonly error: string | null;
  readonly analysis: AnalysisView;
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onOpenDrawer: () => void;
  readonly shortcuts: boolean;
  readonly onCancelAnalysis: (() => void) | null;
  readonly onResumeAnalysis: (() => void) | null;
}

/**
 * The whole window: whatever is playing, or the invitation to put something
 * on.
 *
 * Three ways a song reaches it. A file just handed over plays from its own
 * bytes. A song reopened later plays from the copy kept with it. A song added
 * before audio sources were kept has only its stems, and gets the stage that
 * plays those.
 */
export function Stage({
  staged,
  song,
  opening,
  error,
  analysis,
  vocals,
  onVocals,
  onFiles,
  onOpenDrawer,
  shortcuts,
  onCancelAnalysis,
  onResumeAnalysis,
}: StageProps) {
  if (staged === null) {
    return (
      <div className="stage empty">
        <button type="button" className="songs-open" onClick={onOpenDrawer}>
          songs
        </button>
        <DropZone className="whole" onFiles={onFiles} />
      </div>
    );
  }

  if (staged.url !== null) {
    return (
      <MediaStage
        url={staged.url}
        kind={staged.sourceKind}
        title={staged.title}
        song={song}
        analysis={analysis}
        vocals={vocals}
        onVocals={onVocals}
        onOpenDrawer={onOpenDrawer}
        shortcuts={shortcuts}
        onCancelAnalysis={onCancelAnalysis}
        onResumeAnalysis={onResumeAnalysis}
      />
    );
  }

  if (song !== null && song.sourcePath === null && song.status === 'ready') {
    return (
      <StemStage
        song={song}
        analysis={analysis}
        vocals={vocals}
        onVocals={onVocals}
        onOpenDrawer={onOpenDrawer}
        shortcuts={shortcuts}
      />
    );
  }

  return (
    <div className="stage empty">
      <button type="button" className="songs-open" onClick={onOpenDrawer}>
        songs
      </button>
      <div className="middle">
        <p className="song">{staged.title}</p>
        {error !== null && <p className="error">{error}</p>}
        {error === null && opening && <p className="note">Opening the file…</p>}
        {error === null && !opening && (
          <p className="note">
            Nothing to play for this one. It kept no file of its own, and its stems are not
            finished: drop the same file in again to carry on separating it.
          </p>
        )}
      </div>
    </div>
  );
}
