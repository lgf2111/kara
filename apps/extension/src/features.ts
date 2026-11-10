/**
 * Which edition this build is.
 *
 * `STABLE` is compiled in by `scripts/build-extension.mjs --stable`. The
 * distributed edition has no Duet helper and no Practice: one needs a local
 * process beside the browser, the other needs a microphone and a scoring
 * screen, and neither is something to hand to somebody who just wants karaoke
 * to work. The flag is a build-time constant rather than a runtime setting so
 * the full build stays exactly what it was, and so nothing can turn the
 * features back on in the edition that is given away.
 */

declare const __KARA_STABLE__: boolean | undefined;

export const STABLE: boolean = typeof __KARA_STABLE__ === 'boolean' ? __KARA_STABLE__ : false;
