import { SKIP_SECONDS, VOLUME_STEP } from './time.ts';

/**
 * The keyboard, as a pure function of the key press. The player's own
 * controls are buttons and sliders, so these shortcuts exist for the person
 * who would rather not reach for them, and they must not fire twice when one
 * of those controls has focus.
 */

export interface KeyPress {
  /** `KeyboardEvent.key`. */
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  /** Tag name of whatever has focus, upper case, as the DOM gives it. */
  readonly targetTag?: string;
  /** The focus is inside something the person is typing into. */
  readonly editing?: boolean;
}

export type PlayerCommand =
  | { readonly kind: 'toggle' }
  /** Relative, in seconds. */
  | { readonly kind: 'skip'; readonly seconds: number }
  /** Relative, in parts of full volume. */
  | { readonly kind: 'volume'; readonly delta: number }
  | { readonly kind: 'mute' }
  | { readonly kind: 'fullscreen' };

/**
 * Elements that answer to these keys themselves. A focused button takes
 * space, a focused slider takes the arrows, and taking the key off them would
 * leave the controls unusable by keyboard.
 */
const OWN_KEYS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'DETAILS', 'SUMMARY']);

export function commandForKey(press: KeyPress): PlayerCommand | null {
  // A shortcut with a modifier belongs to the browser or the system.
  if (press.ctrl === true || press.meta === true || press.alt === true) {
    return null;
  }
  if (press.editing === true || OWN_KEYS.has(press.targetTag ?? '')) {
    return null;
  }
  switch (press.key) {
    // 'Spacebar' is what older WebKit sends, and costs nothing to accept.
    case ' ':
    case 'Spacebar':
    case 'k':
      return { kind: 'toggle' };
    case 'ArrowLeft':
      return { kind: 'skip', seconds: -SKIP_SECONDS };
    case 'ArrowRight':
      return { kind: 'skip', seconds: SKIP_SECONDS };
    case 'ArrowUp':
      return { kind: 'volume', delta: VOLUME_STEP };
    case 'ArrowDown':
      return { kind: 'volume', delta: -VOLUME_STEP };
    case 'm':
      return { kind: 'mute' };
    case 'f':
      return { kind: 'fullscreen' };
    default:
      return null;
  }
}
