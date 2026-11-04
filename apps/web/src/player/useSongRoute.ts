import { useCallback, useEffect, useMemo, useState } from 'react';

import { LIBRARY_HASH, playerHashFor, songIdFromHash } from './route.ts';

export interface SongRoute {
  /** The song the address bar asks to play, or null for an empty stage. */
  readonly songId: string | null;
  openPlayer(songId: string): void;
  /** Nothing on the stage, which is also where a deleted song leaves it. */
  clear(): void;
}

/** The hash, as state. Reloading or going back lands on the same song. */
export function useSongRoute(): SongRoute {
  const [songId, setSongId] = useState<string | null>(() => songIdFromHash(location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setSongId(songIdFromHash(location.hash));
    };
    window.addEventListener('hashchange', onChange);
    // The hash may have changed between the first render and this effect.
    onChange();
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);

  const openPlayer = useCallback((id: string): void => {
    location.hash = playerHashFor(id);
  }, []);

  const clear = useCallback((): void => {
    location.hash = LIBRARY_HASH;
  }, []);

  return useMemo(() => ({ songId, openPlayer, clear }), [clear, openPlayer, songId]);
}
