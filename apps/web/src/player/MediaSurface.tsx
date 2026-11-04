import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import type { SongRecord } from '../library/songs.ts';
import { useNotices } from '../notices/Notices.tsx';
import { troubleFrom } from '../notices/notices.ts';
import { PlayGate } from './PlayGate.tsx';
import { StageOverlays } from './StageOverlays.tsx';
import { Waveform } from './Waveform.tsx';
import { vocalToggle, type AnalysisView } from './analysis.ts';
import {
  AUDIO_ONLY_NOTICE,
  describeMediaFailure,
  readMediaFailure,
  readPlayRefusal,
  videoRemedy,
} from './media-failure.ts';
import type { VocalChoice } from './stem-mix.ts';
import { seekTo } from './time.ts';
import { useIdleOverlays } from './useIdleOverlays.ts';
import { useStemMix } from './useStemMix.ts';
import { useTransportControls } from './useTransportControls.ts';
import { useVolume } from './useVolume.ts';

export interface MediaSurfaceProps {
  /** Object URL of the file the song came from. The caller owns and revokes it. */
  readonly url: string;
  /** Whether the file's picture is being shown, or only its sound. */
  readonly picture: boolean;
  /** Said once, when the picture turns out to be undecodable here. */
  readonly onLosePicture: () => void;
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
 * A video brings its own picture. An audio file, and a video this browser
 * cannot decode, get a stage of their own with the same element underneath,
 * so both play the second the file is in and both can hand over to the stems
 * later without restarting.
 *
 * Nothing here is allowed to fail quietly. A refused play puts a play button
 * on the stage, an undecodable picture gives up the picture and says so, and
 * anything else becomes a notice with the browser's own reason under it.
 */
export function MediaSurface({
  url,
  picture,
  onLosePicture,
  title,
  song,
  analysis,
  vocals,
  onVocals,
  onOpenDrawer,
  shortcuts,
  onCancelAnalysis,
  onResumeAnalysis,
}: MediaSurfaceProps) {
  const notices = useNotices();
  const media = useRef<HTMLMediaElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  /** Whether this file has ever got as far as a frame. Decides the remedy. */
  const played = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(Number.NaN);
  const [blocked, setBlocked] = useState(false);

  const start = useCallback((): void => {
    const element = media.current;
    if (element === null) {
      return;
    }
    void element.play().then(
      () => {
        setBlocked(false);
      },
      (cause: unknown) => {
        switch (readPlayRefusal(cause)) {
          case 'needs-a-tap':
            // Not an error: the browser wants to be asked. The gate is the
            // asking, and the song is otherwise ready to go.
            setBlocked(true);
            return;
          case 'interrupted':
            // Something paused it or changed the source underneath. Normal.
            return;
          default:
            notices.report(troubleFrom('playback', cause));
        }
      },
    );
  }, [notices]);

  const toggle = useCallback((): void => {
    const element = media.current;
    if (element === null) {
      return;
    }
    if (element.paused) {
      start();
    } else {
      element.pause();
    }
  }, [start]);

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
  const idle = useIdleOverlays(playing);
  // A song waiting to be let out keeps its controls: the gate is one way to
  // start it and the transport is the other, and hiding the second would be
  // the silent failure in a different shape.
  const shown = idle || blocked;
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
      if (element.currentTime > 0) {
        played.current = true;
      }
      if (!element.paused) {
        setBlocked(false);
      }
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
    const onError = (): void => {
      const failure = readMediaFailure(element.error?.code);
      const kind = picture ? 'video' : 'audio';
      switch (videoRemedy({ kind, failure, played: played.current })) {
        case 'audio-only':
          // Safari can open an MP4 whose video track it cannot decode — AV1
          // on Apple chips before the M3. The sound usually plays, so the
          // song carries on without the picture rather than not at all.
          notices.show({ headline: AUDIO_ONLY_NOTICE, detail: null });
          onLosePicture();
          return;
        case 'report':
          notices.report(troubleFrom('playback', new Error(describeMediaFailure(failure))));
          return;
        case 'ignore':
          return;
      }
    };
    element.addEventListener('error', onError);
    return () => {
      element.removeEventListener('error', onError);
    };
  }, [notices, onLosePicture, picture]);

  useEffect(() => {
    // Asked for rather than left to the `autoplay` attribute, which swallows
    // a refusal. The refusal is the one thing that has to be seen.
    start();
  }, [start, url]);

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
    <div
      ref={frame}
      className={cn(
        'relative size-full overflow-hidden bg-black [&:fullscreen]:size-full',
        !shown && 'cursor-none',
      )}
    >
      {picture ? (
        <video
          ref={(node) => {
            media.current = node;
          }}
          src={url}
          // No `controls`: the bar laid over the bottom is the player.
          playsInline
          title={title}
          // Letterboxed rather than cropped: a lyric video's words are at the edge.
          className={cn('block size-full bg-black object-contain', shown && 'cursor-pointer')}
          onClick={toggle}
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-6 bg-[radial-gradient(circle_at_50%_42%,#24272f,#07080a_76%)] px-6 py-20">
          <audio
            ref={(node) => {
              media.current = node;
            }}
            src={url}
          />
          {/*
            While the browser is holding the song back, the middle of a stage
            with no picture belongs to the play button alone. The title is in
            the bar at the top either way, and that bar is kept up for as long
            as the gate is.
          */}
          {!blocked && (
            <>
              <p className="max-w-[34rem] text-center font-heading text-2xl font-semibold tracking-tight text-white sm:text-4xl">
                {title}
              </p>
              <Waveform
                bars={mix.bars}
                currentSeconds={currentSeconds}
                durationSeconds={durationSeconds}
              />
            </>
          )}
        </div>
      )}

      {blocked && <PlayGate onPlay={start} />}

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
