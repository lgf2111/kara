import { LoaderCircle } from 'lucide-react';

import { DropZone } from '../library/DropZone.tsx';
import type { SongRecord } from '../library/songs.ts';
import { MediaStage } from './MediaStage.tsx';
import { SongsButton } from './SongsButton.tsx';
import { StemStage } from './StemStage.tsx';
import type { AnalysisView } from './analysis.ts';
import type { LyricsRead } from './lyrics-read.ts';
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
  /** Reading the words off the staged song's own picture. */
  readonly read: LyricsRead;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onOpenDrawer: () => void;
  readonly shortcuts: boolean;
  readonly onCancelAnalysis: (() => void) | null;
  readonly onResumeAnalysis: (() => void) | null;
}

/** The empty stage and the dead end share their frame: dark, centred, calm. */
const BACKDROP =
  'relative flex size-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_40%,#1d1f25,#07080a_78%)] p-6';

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
  read,
  onFiles,
  onOpenDrawer,
  shortcuts,
  onCancelAnalysis,
  onResumeAnalysis,
}: StageProps) {
  if (staged === null) {
    return (
      <div className={BACKDROP}>
        <SongsButton onClick={onOpenDrawer} className="absolute top-3 left-3 z-10" />
        <DropZone size="stage" onFiles={onFiles} />
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
        read={read}
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
        read={read}
        onOpenDrawer={onOpenDrawer}
        shortcuts={shortcuts}
      />
    );
  }

  return (
    <div className={BACKDROP}>
      <SongsButton onClick={onOpenDrawer} className="absolute top-3 left-3 z-10" />
      <div className="max-w-md space-y-3 text-center">
        <p className="font-heading text-xl font-semibold tracking-tight text-white">
          {staged.title}
        </p>
        {error !== null && <p className="text-sm text-destructive">{error}</p>}
        {error === null && opening && (
          <p className="flex items-center justify-center gap-2 text-sm text-white/60">
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Opening the file…
          </p>
        )}
        {error === null && !opening && (
          <p className="text-sm leading-relaxed text-white/60">
            Nothing to play for this one. It kept no file of its own, and its stems are not
            finished: drop the same file in again to carry on separating it.
          </p>
        )}
      </div>
    </div>
  );
}
