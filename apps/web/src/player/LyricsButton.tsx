import { Captions, CaptionsOff, LoaderCircle, ScanText } from 'lucide-react';

import { ControlAction } from './ControlAction.tsx';
import type { LyricsRead } from './lyrics-read.ts';
import type { StageLyrics } from './useStageLyrics.ts';

interface LyricsButtonProps {
  readonly lyrics: StageLyrics;
  readonly read: LyricsRead;
}

/**
 * One place in the bar for the words, which is one of three things.
 *
 * A song with lines gets a switch, off to begin with: most of these files are
 * lyric videos that already have their words in the picture, and a second set
 * laid over them is worse than none at all.
 *
 * A song with no lines but a picture to read them off gets the reader
 * instead, in the same spot. Somebody watching a video with no words is at
 * the moment they want them, and sending them to a list to find the song
 * they are already watching is a detour.
 *
 * A song with neither — an audio file, or a video separated before its own
 * bytes were kept — gets nothing, because there is nothing it could do.
 */
export function LyricsButton({ lyrics, read }: LyricsButtonProps) {
  if (lyrics.lines !== null) {
    return (
      <ControlAction
        label={lyrics.on ? 'hide the lyrics' : 'show the lyrics'}
        pressed={lyrics.on}
        onClick={lyrics.toggle}
      >
        {lyrics.on ? (
          <Captions aria-hidden="true" />
        ) : (
          <CaptionsOff aria-hidden="true" />
        )}
      </ControlAction>
    );
  }

  const start = read.start;
  if (start === null) {
    return null;
  }

  if (read.job !== null) {
    // The reading takes minutes and the chip in the corner says how it is
    // going, so the button becomes the way to stop it.
    return (
      <ControlAction
        label={read.cancelling ? 'stopping' : 'stop reading the lyrics'}
        disabled={read.cancelling}
        onClick={read.cancel}
      >
        <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      </ControlAction>
    );
  }

  return (
    <ControlAction
      label={
        read.busy
          ? 'reading the lyrics has to wait for the job on the go'
          : 'read the lyrics off this video'
      }
      disabled={read.busy}
      onClick={start}
    >
      <ScanText aria-hidden="true" />
    </ControlAction>
  );
}
