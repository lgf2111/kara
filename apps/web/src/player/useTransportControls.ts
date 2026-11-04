import { useCallback, useMemo, type RefObject } from 'react';

import type { PlayerCommand } from './keys.ts';
import type { Transport } from './transport.ts';
import { useFullscreen } from './useFullscreen.ts';
import { usePlayerKeys } from './usePlayerKeys.ts';
import type { Volume } from './useVolume.ts';

/**
 * One transport out of the parts each stage has of its own.
 *
 * What differs between the two stages is who keeps time: a media element
 * answers for itself, and a song that is nothing but stems is counted off the
 * audio clock. What does not differ is the bar laid over it, so everything
 * around that answer — the screen, the keyboard, the volume — is assembled
 * here once.
 */

interface Moves {
  readonly playing: boolean;
  readonly currentSeconds: number;
  readonly durationSeconds: number;
  /** The element to fill the screen with. */
  readonly frame: RefObject<Element | null>;
  /** The keys are off while something else has the room, such as the drawer. */
  readonly shortcuts: boolean;
  readonly volume: Volume;
  toggle(): void;
  skip(seconds: number): void;
  seek(seconds: number): void;
}

export function useTransportControls({
  playing,
  currentSeconds,
  durationSeconds,
  frame,
  shortcuts,
  volume,
  toggle,
  skip,
  seek,
}: Moves): Transport {
  const { on: fullscreen, toggle: toggleFullscreen } = useFullscreen(frame);

  const apply = useCallback(
    (command: PlayerCommand): void => {
      if (!shortcuts) {
        return;
      }
      switch (command.kind) {
        case 'toggle':
          toggle();
          return;
        case 'skip':
          skip(command.seconds);
          return;
        case 'volume':
          volume.set(volume.volume + command.delta);
          return;
        case 'mute':
          volume.toggle();
          return;
        case 'fullscreen':
          toggleFullscreen();
      }
    },
    [shortcuts, skip, toggle, toggleFullscreen, volume],
  );

  usePlayerKeys(apply);

  return useMemo<Transport>(
    () => ({
      playing,
      currentSeconds,
      durationSeconds,
      volume: volume.volume,
      muted: volume.muted,
      fullscreen,
      toggle,
      skip,
      seek,
      setVolume: volume.set,
      toggleMute: volume.toggle,
      toggleFullscreen,
    }),
    [
      currentSeconds,
      durationSeconds,
      fullscreen,
      playing,
      seek,
      skip,
      toggle,
      toggleFullscreen,
      volume,
    ],
  );
}
