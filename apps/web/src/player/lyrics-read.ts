import { formatEta } from '../library/format.ts';
import type { LyricsJob } from '../library/useLibrary.ts';

/**
 * Reading the words off a song's own picture, offered from the stage.
 *
 * The same read the drawer starts, reached without leaving the song: a video
 * with no lines yet is exactly the moment somebody wants them, and sending
 * them to a list to find the song they are already watching is a detour.
 *
 * One shape rather than five props, because it has to be handed down through
 * the stage to the bar at the bottom of it.
 */
export interface LyricsRead {
  /** Starts the read, or null when this song has no picture to read from. */
  readonly start: (() => void) | null;
  /** Something else holds the machine: it cannot separate and read at once. */
  readonly busy: boolean;
  /** The read running on the song on the stage, or null when none is. */
  readonly job: LyricsJob | null;
  /** Cancel was asked for; the worker stops after the frame it is on. */
  readonly cancelling: boolean;
  cancel(): void;
}

/** One line for the chip. Counts and times only: never a word that was read. */
export function describeLyricsRead(job: LyricsJob): string {
  const frames =
    job.framesTotal > 0
      ? `, frame ${String(job.framesDone)} of ${String(job.framesTotal)}`
      : '';
  const left = job.etaMs === null ? '' : `, about ${formatEta(job.etaMs)} left`;
  return `reading the lyrics: ${job.stage}${frames}${left}`;
}

/** How far the read has got, 0 to 1, or null before the frames are counted. */
export function lyricsReadShare(job: LyricsJob): number | null {
  if (!Number.isFinite(job.framesTotal) || job.framesTotal <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, job.framesDone / job.framesTotal));
}
