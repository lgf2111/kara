import { cn } from '@/lib/utils';
import { barsPlayed } from './waveform.ts';

interface WaveformProps {
  /** One height per bar, 0 to 1. Empty until the stems have been read. */
  readonly bars: readonly number[];
  readonly currentSeconds: number;
  readonly durationSeconds: number;
}

/**
 * The song's own shape, for a song with no picture.
 *
 * Decorative: the clock and the seek bar say where it is. This is here so a
 * room staring at an audio file has something that belongs to that file
 * rather than a logo. It appears when the stems do, because their samples are
 * the only honest thing to draw it from.
 */
export function Waveform({ bars, currentSeconds, durationSeconds }: WaveformProps) {
  if (bars.length === 0) {
    return null;
  }
  const played = barsPlayed(currentSeconds, durationSeconds, bars.length);

  return (
    <div className="flex h-20 w-[min(40rem,100%)] items-center gap-px" aria-hidden="true">
      {bars.map((height, index) => (
        <span
          key={index}
          className={cn(
            'min-h-0.5 flex-1 rounded-full transition-colors',
            index < played ? 'bg-white/90' : 'bg-white/20',
          )}
          style={{ height: `${String(Math.round(height * 100))}%` }}
        />
      ))}
    </div>
  );
}
