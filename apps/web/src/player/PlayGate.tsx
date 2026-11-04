import { Play } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface PlayGateProps {
  readonly onPlay: () => void;
}

/**
 * The song is loaded and the browser will not start it.
 *
 * Safari refuses to play anything nobody asked for, and the refusal comes
 * back as a rejected promise rather than as anything on screen. Left alone
 * that is a stage which looks like it is playing and is silent, so the
 * refusal gets the biggest thing on the stage instead.
 *
 * It does not cover the bars: the wrapper takes no pointer events, so the
 * transport laid over the bottom is still there to reach for, which is the
 * other half of not failing silently.
 */
export function PlayGate({ onPlay }: PlayGateProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/40">
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label="play"
        className="pointer-events-auto size-24 rounded-full border border-white/25 bg-white/10 text-white backdrop-blur-md hover:bg-white/20 hover:text-white"
        onClick={onPlay}
      >
        <Play className="size-10" aria-hidden="true" />
      </Button>
      <p className="max-w-xs text-center text-sm text-white/70">
        This browser will not start a song by itself. Press play to begin.
      </p>
    </div>
  );
}
