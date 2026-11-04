import { useCallback, useMemo, useState } from 'react';

import { clampVolume } from './time.ts';

export interface Volume {
  readonly volume: number;
  readonly muted: boolean;
  set(value: number): void;
  toggle(): void;
}

/**
 * How loud the room is.
 *
 * Held by the stage rather than by the element, because it has to reach
 * whichever of the two is carrying the sound: with the voice taken out the
 * element is muted and the stems are the song, so the element's own volume
 * stops being the room's.
 */
export function useVolume(): Volume {
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const set = useCallback((value: number): void => {
    const next = clampVolume(value);
    setVolume(next);
    // Reaching for the volume means wanting to hear it, and dragging it to
    // nothing means the opposite.
    setMuted(next === 0);
  }, []);

  const toggle = useCallback((): void => {
    setMuted((on) => !on);
  }, []);

  return useMemo(() => ({ volume, muted, set, toggle }), [muted, set, toggle, volume]);
}
