import { useCallback, useEffect, useRef, useState } from 'react';

import { idleAtRest, idleStep, type IdleEvent } from './idle.ts';

/**
 * Whether the overlays are on show, from {@link idleStep} and the clock.
 *
 * The state itself is kept in a ref and only `shown` reaches React: every
 * mouse move is an event, and a room is a lot of mouse moves. Setting the
 * same boolean twice costs nothing, so the stage redraws when the bars come
 * and go and not before.
 *
 * The listeners sit on the document because a hand anywhere in the window
 * means somebody is there, including on the bars themselves.
 */

/** How often the clock is compared with the last activity. */
const TICK_MS = 250;

const WAKING = ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'wheel'] as const;

export function useIdleOverlays(playing: boolean): boolean {
  const state = useRef(idleAtRest(performance.now()));
  const [shown, setShown] = useState(true);

  const step = useCallback((event: IdleEvent): void => {
    const next = idleStep(state.current, event);
    state.current = next;
    setShown(next.shown);
  }, []);

  useEffect(() => {
    step({ kind: 'playing', playing, atMs: performance.now() });
  }, [playing, step]);

  useEffect(() => {
    const wake = (): void => {
      step({ kind: 'activity', atMs: performance.now() });
    };
    for (const name of WAKING) {
      document.addEventListener(name, wake, { passive: true });
    }
    const timer = setInterval(() => {
      step({ kind: 'tick', atMs: performance.now() });
    }, TICK_MS);

    return () => {
      clearInterval(timer);
      for (const name of WAKING) {
        document.removeEventListener(name, wake);
      }
    };
  }, [step]);

  return shown;
}
