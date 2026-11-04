import { useCallback, useEffect, useRef, useState } from 'react';

import type { SongRecord, SourceKind } from '../library/songs.ts';
import { StageOverlays } from './StageOverlays.tsx';
import { Waveform } from './Waveform.tsx';
import { vocalToggle, type AnalysisView } from './analysis.ts';
import type { VocalChoice } from './stem-mix.ts';
import { seekTo } from './time.ts';
import { useIdleOverlays } from './useIdleOverlays.ts';
import { useStemMix } from './useStemMix.ts';
import { useTransportControls } from './useTransportControls.ts';
import { useVolume } from './useVolume.ts';

interface MediaStageProps {
  /** Object URL of the file the song came from. The caller owns and revokes it. */
  readonly url: string;
  readonly kind: SourceKind;
  readonly title: string;
  /** The record, once the picked file has been decoded and written. */
  readonly song: SongRecord | null;
  readonly analysis: AnalysisView;
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
  readonly onOpenDrawer: () => void;
  /** Off while the drawer has the room's attention. */
  readonly shortcuts: boolean;
  readonly onCancelAnalysis: (() => void) | null;
  readonly onResumeAnalysis: (() => void) | null;
}

/** Events that can change where the song is, or whether it is going. */
const WATCHED = [
  'play',
  'playing',
  'pause',
  'ended',
  'timeupdate',
  'seeked',
  'durationchange',
  'loadedmetadata',
] as const;

/**
 * The song, playing from the file the person handed over.
 *
 * The element is the only copy of whether it is playing and where it has
 * reached: every control asks it to change, and what is drawn comes from its
 * own events. Mirroring that in React would mean two answers to "is it
 * playing", and they would disagree the moment the song ended on its own.
 *
 * A video brings its own picture. An audio file gets a stage of its own, but
 * the same element underneath, so both play the second the file is in and
 * both can hand over to the stems later without restarting.
 */
export function MediaStage({
  url,
  kind,
  title,
  song,
  analysis,
  vocals,
  onVocals,
  onOpenDrawer,
  shortcuts,
  onCancelAnalysis,
  onResumeAnalysis,
}: MediaStageProps) {
  const media = useRef<HTMLMediaElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(Number.NaN);

  const toggle = useCallback((): void => {
    const element = media.current;
    if (element === null) {
      return;
    }
    if (element.paused) {
      // A play the browser refuses is not an error worth a screen: the
      // button is still there to press again.
      void element.play().catch(() => undefined);
    } else {
      element.pause();
    }
  }, []);

  const skip = useCallback((seconds: number): void => {
    const element = media.current;
    if (element !== null) {
      element.currentTime = seekTo(element.currentTime, seconds, element.duration);
    }
  }, []);

  const seek = useCallback((seconds: number): void => {
    const element = media.current;
    if (element !== null) {
      element.currentTime = seekTo(0, seconds, element.duration);
    }
  }, []);

  const sound = useVolume();
  const transport = useTransportControls({
    playing,
    currentSeconds,
    durationSeconds,
    frame,
    shortcuts,
    volume: sound,
    toggle,
    skip,
    seek,
  });
  const mix = useStemMix({
    media,
    song,
    choice: vocals,
    volume: sound.volume,
    muted: sound.muted,
  });
  const shown = useIdleOverlays(playing);
  const toggleState = vocalToggle(analysis, mix.state);

  useEffect(() => {
    const element = media.current;
    if (element === null) {
      return;
    }
    // One handler for all of them: the element is the answer to every one of
    // these questions, so there is nothing to be gained by asking separately.
    const read = (): void => {
      setPlaying(!element.paused && !element.ended);
      setCurrentSeconds(element.currentTime);
      setDurationSeconds(element.duration);
    };
    for (const name of WATCHED) {
      element.addEventListener(name, read);
    }
    read();

    return () => {
      for (const name of WATCHED) {
        element.removeEventListener(name, read);
      }
    };
  }, [url]);

  useEffect(() => {
    const element = media.current;
    if (element === null) {
      return;
    }
    element.volume = sound.volume;
    // Muted for the stems' sake, not the person's: with the voice out, the
    // file's own track is the voice they asked to be rid of.
    element.muted = sound.muted || mix.silenceSource;
  }, [mix.silenceSource, sound.muted, sound.volume]);

  return (
    <div className={shown ? 'stage' : 'stage idle'} ref={frame}>
      {kind === 'video' ? (
        <video
          ref={(node) => {
            media.current = node;
          }}
          src={url}
          // No `controls`: the bar laid over the bottom is the player.
          autoPlay
          playsInline
          title={title}
          onClick={toggle}
        />
      ) : (
        <div className="art">
          <audio
            ref={(node) => {
              media.current = node;
            }}
            src={url}
            autoPlay
          />
          <p className="song">{title}</p>
          <Waveform
            bars={mix.bars}
            currentSeconds={currentSeconds}
            durationSeconds={durationSeconds}
          />
        </div>
      )}

      <StageOverlays
        title={title}
        shown={shown}
        transport={transport}
        vocals={vocals}
        onVocals={onVocals}
        toggle={toggleState}
        analysis={analysis}
        onOpenDrawer={onOpenDrawer}
        onCancelAnalysis={onCancelAnalysis}
        onResumeAnalysis={onResumeAnalysis}
        error={mix.error}
      />
    </div>
  );
}
