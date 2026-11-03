import { useCallback, useRef, useState } from 'react';

import type { SongRecord } from '../library/songs.ts';
import { Controls } from './Controls.tsx';
import { VocalsControl } from './VocalsControl.tsx';
import type { PlayerCommand } from './keys.ts';
import type { VocalChoice } from './stem-mix.ts';
import { clampVolume } from './time.ts';
import { useFullscreen } from './useFullscreen.ts';
import { usePlayerKeys } from './usePlayerKeys.ts';
import { useStemPlayer } from './useStemPlayer.ts';
import { barsPlayed } from './waveform.ts';

interface AudioStageProps {
  readonly song: SongRecord;
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
}

/**
 * A song that came in as audio, so there is no picture and no element: the
 * stems are the sound, the clock and everything there is to look at.
 *
 * Unlike the video stage, nothing can be asked whether it is playing, so what
 * is drawn comes from the player hook rather than from an element's events,
 * and the volume reaches the stems in both modes because nothing else carries
 * the sound.
 */
export function AudioStage({ song, vocals, onVocals }: AudioStageProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const { on: fullscreen, toggle: toggleFullscreen } = useFullscreen(frame);
  const player = useStemPlayer({ song, choice: vocals, volume, muted });
  const { toggle, skip, seek } = player;

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

  usePlayerKeys(apply);

  const played = barsPlayed(player.currentSeconds, player.durationSeconds, player.bars.length);

  return (
    <div className="stage audio" ref={frame}>
      <div className="art">
        <p className="song">{song.title}</p>
        <button
          type="button"
          className="big"
          // Nothing to play until the stems are read, and a button that does
          // nothing when pressed is worse than one that says so.
          disabled={player.state !== 'ready'}
          aria-label={player.playing ? 'pause' : 'play'}
          onClick={toggle}
        >
          {player.playing ? 'pause' : 'play'}
        </button>
        {/* Decorative: the clock and the bar below say where the song is. */}
        <div className="wave" aria-hidden="true">
          {player.bars.map((height, index) => (
            <span
              key={index}
              className={index < played ? 'bar on' : 'bar'}
              style={{ height: `${String(Math.round(height * 100))}%` }}
            />
          ))}
        </div>
      </div>

      <Controls
        playing={player.playing}
        currentSeconds={player.currentSeconds}
        durationSeconds={player.durationSeconds}
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
        mix={player}
        choice={vocals}
        onChoice={onVocals}
        stemsOnly
      />
    </div>
  );
}
