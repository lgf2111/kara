/**
 * What a caught `unknown` has to say for itself. Never empty.
 *
 * The web app has a richer version of this in `src/notices/notices.ts`, which
 * also files a failure under the part of the app it came from. An extension
 * has no such parts and no toast to put them in: a reason here goes into a
 * status message and the console, so the message is all that is wanted.
 */
export function reasonText(cause: unknown): string {
  if (cause instanceof Error) {
    const named = cause.name === '' || cause.name === 'Error' ? '' : `${cause.name}: `;
    return cause.message === '' ? `${named}no reason given`.trim() : `${named}${cause.message}`;
  }
  if (typeof cause === 'string' && cause !== '') {
    return cause;
  }
  return 'no reason given';
}
