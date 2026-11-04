import { cn } from '@/lib/utils';
import type { LyricLine } from '../library/songs.ts';
import { lyricCueAt } from './lyric-cue.ts';

interface LyricOverlayProps {
  readonly lines: readonly LyricLine[];
  /** Where the song has reached, from whichever clock the stage is keeping. */
  readonly currentSeconds: number;
  /** The controls are up, so the words move clear of them. */
  readonly raised: boolean;
}

/**
 * The words, over the lower third of the song.
 *
 * Low rather than in the middle, because the middle is the picture and a KTV
 * room is used to reading along the bottom of one. Big, because it is read
 * from across the room, and shadowed, because it is read off whatever happens
 * to be behind it.
 *
 * The line coming next sits under it, smaller and dimmer. That is the part
 * that makes a song singable: seeing the next line before it arrives is the
 * difference between singing and reading.
 *
 * Which line is which is {@link lyricCueAt}'s answer, from the clock alone.
 * Nothing is kept here, so a seek, a pause or a song that ended lands on the
 * right line with no state of its own to get out of step.
 */
export function LyricOverlay({ lines, currentSeconds, raised }: LyricOverlayProps) {
  const cue = lyricCueAt(lines, currentSeconds * 1000);
  const live = cue.current !== null;

  return (
    <div
      className={cn(
        // No pointer events: the picture behind this is the click target for
        // play and pause, and the words must not come between them.
        'pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-2 px-6 text-center transition-all duration-300 motion-reduce:transition-none',
        // Clear of the bar at the bottom while it is up, and back down into
        // the lower third once the room has settled and the bar has gone.
        raised ? 'bottom-52 sm:bottom-44' : 'bottom-[12%]',
      )}
      role="group"
      // Named but not announced. These change every few seconds, and a screen
      // reader reading each one over the last would bury everything else the
      // player has to say; the whole set is in the drawer as text instead.
      aria-label="lyrics"
      aria-live="off"
    >
      {cue.reached !== null && (
        <p
          // Keyed by the line, so each new one fades in. It stays mounted
          // through the silence after it, where the class below fades it out
          // rather than cutting it off mid-word.
          key={cue.index}
          className={cn(
            'max-w-[46rem] font-heading text-2xl leading-tight font-semibold tracking-tight text-balance text-white [text-shadow:0_2px_14px_rgb(0_0_0/0.9)] sm:text-4xl',
            'animate-in fade-in transition-opacity duration-300 motion-reduce:animate-none motion-reduce:transition-none',
            live ? 'opacity-100' : 'opacity-0',
          )}
        >
          {cue.reached.text}
        </p>
      )}

      {cue.next !== null && (
        <p className="max-w-[40rem] font-heading text-base leading-snug text-balance text-white/55 [text-shadow:0_1px_10px_rgb(0_0_0/0.9)] sm:text-xl">
          {cue.next.text}
        </p>
      )}
    </div>
  );
}
