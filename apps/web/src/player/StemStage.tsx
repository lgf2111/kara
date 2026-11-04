import { useRef } from 'react';

import type { SongRecord } from '../library/songs.ts';
import { StageOverlays } from './StageOverlays.tsx';
import { Waveform } from './Waveform.tsx';
import { vocalToggle, type AnalysisView } from './analysis.ts';
import type { VocalChoice } from './stem-mix.ts';
import { useIdleOverlays } from './useIdleOverlays.ts';
import { useStemPlayer } from './useStemPlayer.ts';
import { useTransportControls } from './useTransportControls.ts';
import { useVolume } from './useVolume.ts';

interface StemStageProps {
  readonly song: SongRecord;
  readonly analysis: AnalysisView;
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
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
  onOpenDrawer,
  shortcuts,
}: StemStageProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const sound = useVolume();
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
    toggle: player.toggle,
    skip: player.skip,
    seek: player.seek,
  });
  const shown = useIdleOverlays(player.playing);

  return (
    <div className={shown ? 'stage' : 'stage idle'} ref={frame}>
      <div className="art">
        <p className="song">{song.title}</p>
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
        onOpenDrawer={onOpenDrawer}
        onCancelAnalysis={null}
        onResumeAnalysis={null}
        error={player.error}
      />
    </div>
  );
}
