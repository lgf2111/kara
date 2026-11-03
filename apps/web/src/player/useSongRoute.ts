import { useCallback, useEffect, useState } from 'react';

import { LIBRARY_HASH, playerHashFor, songIdFromHash } from './route.ts';

export interface SongRoute {
  /** The song the address bar asks to play, or null for the library. */
  readonly songId: string | null;
  openPlayer(songId: string): void;
  openLibrary(): void;
}

/** The hash, as state. Reloading or going back lands on the same screen. */
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

  const openLibrary = useCallback((): void => {
    location.hash = LIBRARY_HASH;
  }, []);

  return { songId, openPlayer, openLibrary };
}
