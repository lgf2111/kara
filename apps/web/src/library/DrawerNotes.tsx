import { SKIP_SECONDS } from '../player/time.ts';

/**
 * What the room should know and nothing it has to act on: the keys, the legal
 * line this app holds itself to, and whether the browser is isolated enough
 * to separate anything.
 *
 * At the bottom of the drawer because none of it changes, and a person
 * reading it is not in the middle of doing something else.
 */
export function DrawerNotes() {
  return (
    <footer className="space-y-2 text-xs leading-relaxed text-muted-foreground">
      <p>
        Space plays and pauses, the left and right arrows skip {SKIP_SECONDS} seconds, up and down
        change the volume, m mutes, f fills the screen and l shows the lyrics of a song that has
        them.
      </p>
      <p>
        Upload only, by design: there is no link import and no downloader. Your file is decoded and
        separated in this tab, and what you share with a friend holds timings and settings, never
        audio. Lyrics read off your own video stay on this device too.
      </p>
      <p>
        Cross-origin isolation:{' '}
        <strong className="text-foreground">{crossOriginIsolated ? 'on' : 'off'}</strong>.
        Separation needs it.
      </p>
    </footer>
  );
}
