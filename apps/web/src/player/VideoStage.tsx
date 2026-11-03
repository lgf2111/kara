import { useCallback, useEffect, useRef, useState } from 'react';

import { Controls } from './Controls.tsx';
import { commandForKey, type PlayerCommand } from './keys.ts';
import { clampVolume, seekTo } from './time.ts';

interface VideoStageProps {
  /** Object URL of the kept file. The caller owns it and revokes it. */
  readonly url: string;
  readonly title: string;
}

/**
 * The picture and the state of what is playing.
 *
 * The element is the only copy of that state: every control asks it to
 * change, and what is drawn comes from its own events. Mirroring it in React
 * would mean two answers to "is it playing", and they would disagree the
 * moment the song ended on its own.
 */
export function VideoStage({ url, title }: VideoStageProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(Number.NaN);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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
    const element = video.current;
    if (element !== null) {
      element.volume = clampVolume(value);
      // Reaching for the volume means wanting to hear it.
      element.muted = element.volume === 0;
    }
  }, []);

  const toggleMute = useCallback((): void => {
    const element = video.current;
    if (element !== null) {
      element.muted = !element.muted;
    }
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
          changeVolume((video.current?.volume ?? 1) + command.delta);
          return;
        case 'mute':
          toggleMute();
          return;
        case 'fullscreen':
          toggleFullscreen();
      }
    },
    [changeVolume, skip, toggle, toggleFullscreen, toggleMute],
  );

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
        title={title}
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
        onLoadedMetadata={(event) => {
          setDurationSeconds(event.currentTarget.duration);
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
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
    </div>
  );
}
