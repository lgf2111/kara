import { reasonText } from '../reason.ts';

/**
 * The microphone contract shared by the popup's permission button and the
 * offscreen practice room.
 *
 * One channel, echo cancellation on and noise suppression on because a singer
 * is heard over speakers in the same room, and automatic gain off because the
 * level has to mean something: a note that is quiet is quiet. The practice
 * graph never connects to `context.destination`, so headphones remain the
 * honest advice rather than something the graph could enforce.
 */
export interface MicrophoneTrack {
  stop: () => void;
}

/** Just enough of a `MediaStream` to release it, without a DOM type. */
export interface MicrophoneStream {
  getTracks: () => readonly MicrophoneTrack[];
}

export const MIC_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
} as const;

function named(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'name' in cause
    ? String((cause as { readonly name?: unknown }).name ?? '')
    : '';
}

/**
 * A microphone failure in words somebody can act on.
 *
 * `practice` is the offscreen document, which cannot show a permission
 * prompt of its own; it points at the popup's Enable microphone button.
 * `popup` is that button, so it points at Chrome's own permission instead.
 */
export function microphoneErrorText(cause: unknown, where: 'practice' | 'popup'): string {
  const name = named(cause);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return where === 'practice'
      ? 'Microphone access is blocked. Open the Kara popup and press Enable microphone once, then start Practice again.'
      : 'Chrome blocked the microphone. Allow it for Kara, then press Enable microphone again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect one and try again.';
  }
  return `The microphone could not be opened: ${reasonText(cause)}`;
}

/** Release every track a permission click or a practice run opened. */
export function stopMicrophone(stream: MicrophoneStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
