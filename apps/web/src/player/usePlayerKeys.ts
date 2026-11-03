import { useEffect } from 'react';

import { commandForKey, type PlayerCommand } from './keys.ts';

/**
 * The player's keyboard, for whichever stage is on.
 *
 * The listener sits on the document, because the keys are for the person who
 * would rather not reach for the controls at all, so only one stage can have
 * them at a time. What a key means is decided by `keys.ts`; what to do about
 * it belongs to the stage.
 */
export function usePlayerKeys(apply: (command: PlayerCommand) => void): void {
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
      // Space would otherwise scroll the page out from under the stage.
      event.preventDefault();
      apply(command);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [apply]);
}
