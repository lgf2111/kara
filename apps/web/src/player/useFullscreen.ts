import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface Fullscreen {
  readonly on: boolean;
  toggle(): void;
}

/**
 * Whether the stage fills the screen.
 *
 * The browser owns the answer rather than this: a request can be refused, and
 * the person can leave with the escape key without touching the button. So it
 * is read back off the document on every change instead of being remembered
 * here, where it would be wrong the first time they pressed escape.
 */
export function useFullscreen(frame: RefObject<Element | null>): Fullscreen {
  const [on, setOn] = useState(false);

  const toggle = useCallback((): void => {
    const container = frame.current;
    if (container === null) {
      return;
    }
    const request =
      document.fullscreenElement === null ? container.requestFullscreen() : document.exitFullscreen();
    // Refused by the browser, or not allowed on this device: nothing to do.
    void request.catch(() => undefined);
  }, [frame]);

  useEffect(() => {
    const onChange = (): void => {
      setOn(document.fullscreenElement !== null);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  return { on, toggle };
}
