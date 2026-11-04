import { useRef } from 'react';

import { cn } from '@/lib/utils';
import type { SongRecord } from '../library/songs.ts';
import { StageOverlays } from './StageOverlays.tsx';
import { Waveform } from './Waveform.tsx';
import { vocalToggle, type AnalysisView } from './analysis.ts';
import type { LyricsRead } from './lyrics-read.ts';
import type { VocalChoice } from './stem-mix.ts';
import { useIdleOverlays } from './useIdleOverlays.ts';
import { useStageLyrics } from './useStageLyrics.ts';
import { useStemPlayer } from './useStemPlayer.ts';
import { useTransportControls } from './useTransportControls.ts';
import { useVolume } from './useVolume.ts';

interface StemStageProps {
  readonly song: SongRecord;
  readonly analysis: AnalysisView;
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
  /**
   * Reading words off a picture, which this song has none of: it kept no file
   * of its own. Taken all the same so the bar is assembled the same way on
   * both stages, and it offers nothing.
   */
  readonly read: LyricsRead;
  readonly onOpenDrawer: () => void;
  readonly shortcuts: boolean;
}

/**
 * A song whose stems are the only copy of it on this device.
 *
 * Songs added since keep the file they arrived as and play from it. This
 * stage is for the ones added before that, which kept nothing but what
 * separation produced: there is no element, so the stems are the sound, the
 * clock and everything there is to look at, and there is nothing to play
 * until they have been read off the disk.
 *
 * It does not start on its own either. The sound is Web Audio, which a
 * browser will not let out until somebody has asked for it, so the song waits
 * on the play button rather than pretending to be playing.
 */
export function StemStage({
  song,
  analysis,
  vocals,
  onVocals,
  read,
  onOpenDrawer,
  shortcuts,
}: StemStageProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const sound = useVolume();
  const lyrics = useStageLyrics(song);
  const player = useStemPlayer({
    song,
    choice: vocals,
    volume: sound.volume,
    muted: sound.muted,
  });
  const transport = useTransportControls({
    playing: player.playing,
    currentSeconds: player.currentSeconds,
    durationSeconds: player.durationSeconds,
    frame,
    shortcuts,
    volume: sound,
    toggleLyrics: lyrics.lines === null ? null : lyrics.toggle,
    toggle: player.toggle,
    skip: player.skip,
    seek: player.seek,
  });
  const shown = useIdleOverlays(player.playing);

  return (
    <div
      ref={frame}
      className={cn(
        'relative size-full overflow-hidden bg-black [&:fullscreen]:size-full',
        !shown && 'cursor-none',
      )}
    >
      <div className="flex size-full flex-col items-center justify-center gap-6 bg-[radial-gradient(circle_at_50%_42%,#24272f,#07080a_76%)] px-6 py-20">
        <p className="max-w-[34rem] text-center font-heading text-2xl font-semibold tracking-tight text-white sm:text-4xl">
          {song.title}
        </p>
        <Waveform
          bars={player.bars}
          currentSeconds={player.currentSeconds}
          durationSeconds={player.durationSeconds}
        />
      </div>

      <StageOverlays
        title={song.title}
        shown={shown}
        transport={transport}
        vocals={vocals}
        onVocals={onVocals}
        toggle={vocalToggle(analysis, player.state)}
        analysis={analysis}
        lyrics={lyrics}
        read={read}
        onOpenDrawer={onOpenDrawer}
        onCancelAnalysis={null}
        onResumeAnalysis={null}
        error={player.error}
      />
    </div>
  );
}
