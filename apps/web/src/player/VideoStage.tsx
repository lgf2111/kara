import { useCallback, useEffect, useRef, useState } from 'react';

import type { SongRecord } from '../library/songs.ts';
import { Controls } from './Controls.tsx';
import { VocalsControl } from './VocalsControl.tsx';
import { commandForKey, type PlayerCommand } from './keys.ts';
import type { VocalChoice } from './stem-mix.ts';
import { clampVolume, seekTo } from './time.ts';
import { useStemMix } from './useStemMix.ts';

interface VideoStageProps {
  /** Object URL of the kept file. The caller owns it and revokes it. */
  readonly url: string;
  readonly song: SongRecord;
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
}

/**
 * The picture and the state of what is playing.
 *
 * The element is the only copy of whether it is playing and where it has
 * reached: every control asks it to change, and what is drawn comes from its
 * own events. Mirroring that in React would mean two answers to "is it
 * playing", and they would disagree the moment the song ended on its own.
 *
 * The volume is the exception. With the vocals out, the sound comes from the
 * stems and the element is muted, so what the person asked for has to be held
 * somewhere that is not the element, and then pointed at whichever is
 * playing.
 */
export function VideoStage({ url, song, vocals, onVocals }: VideoStageProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(Number.NaN);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const mix = useStemMix({ video, song, choice: vocals, volume, muted });

  const toggle = useCallback((): void => {
    const element = video.current;
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
    const element = video.current;
    if (element !== null) {
      element.currentTime = seekTo(element.currentTime, seconds, element.duration);
    }
  }, []);

  const seek = useCallback((seconds: number): void => {
    const element = video.current;
    if (element !== null) {
      element.currentTime = seekTo(0, seconds, element.duration);
    }
  }, []);

  const changeVolume = useCallback((value: number): void => {
    const next = clampVolume(value);
    setVolume(next);
    // Reaching for the volume means wanting to hear it, and dragging it to
    // nothing means the opposite.
    setMuted(next === 0);
  }, []);

  const toggleMute = useCallback((): void => {
    setMuted((on) => !on);
  }, []);

  const toggleFullscreen = useCallback((): void => {
    const container = frame.current;
    if (container === null) {
      return;
    }
    const request =
      document.fullscreenElement === null ? container.requestFullscreen() : document.exitFullscreen();
    // Refused by the browser, or not allowed on this device: nothing to do.
    void request.catch(() => undefined);
  }, []);

  const apply = useCallback(
    (command: PlayerCommand): void => {
      switch (command.kind) {
        case 'toggle':
          toggle();
          return;
        case 'skip':
          skip(command.seconds);
          return;
        case 'volume':
          changeVolume(volume + command.delta);
          return;
        case 'mute':
          toggleMute();
          return;
        case 'fullscreen':
          toggleFullscreen();
      }
    },
    [changeVolume, skip, toggle, toggleFullscreen, toggleMute, volume],
  );

  useEffect(() => {
    const element = video.current;
    if (element === null) {
      return;
    }
    element.volume = volume;
    // Muted for the stems' sake, not the person's: in instrumental mode the
    // element's own track is the voice they asked to be rid of.
    element.muted = muted || mix.silenceVideo;
  }, [mix.silenceVideo, muted, volume]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      const command = commandForKey({
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        targetTag: target instanceof Element ? target.tagName : '',
        editing: target instanceof HTMLElement && target.isContentEditable,
      });
      if (command === null) {
        return;
      }
      // Space would otherwise scroll the page out from under the video.
      event.preventDefault();
      apply(command);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [apply]);

  useEffect(() => {
    const onChange = (): void => {
      setFullscreen(document.fullscreenElement !== null);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  return (
    <div className="stage" ref={frame}>
      <video
        ref={video}
        src={url}
        // No `controls`: the bar below is the player, and the native one would
        // sit on top of it with its own idea of what the keys do.
        autoPlay
        playsInline
        title={song.title}
        onClick={toggle}
        onPlay={() => {
          setPlaying(true);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onEnded={() => {
          setPlaying(false);
        }}
        onTimeUpdate={(event) => {
          setCurrentSeconds(event.currentTarget.currentTime);
        }}
        onSeeked={(event) => {
          setCurrentSeconds(event.currentTarget.currentTime);
        }}
        onDurationChange={(event) => {
          setDurationSeconds(event.currentTarget.duration);
        }}
      />
      <Controls
        playing={playing}
        currentSeconds={currentSeconds}
        durationSeconds={durationSeconds}
        volume={volume}
        muted={muted}
        fullscreen={fullscreen}
        onToggle={toggle}
        onSkip={skip}
        onSeek={seek}
        onVolume={changeVolume}
        onMute={toggleMute}
        onFullscreen={toggleFullscreen}
      />
      <VocalsControl
        songStatus={song.status}
        mix={mix}
        choice={vocals}
        onChoice={onVocals}
      />
    </div>
  );
}
