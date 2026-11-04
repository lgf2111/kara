import { formatEta, formatPercent } from '../library/format.ts';
import type { SongStatus } from '../library/songs.ts';
import {
  placeInQueue,
  type AnalysisItem,
  type AnalysisJob,
  type JobQueue,
} from '../separation/queue.ts';
import type { StemMixState } from './stem-mix.ts';

/**
 * What separation is doing for the song on the stage, as one small answer the
 * progress chip and the vocal toggle can both read.
 *
 * The question is awkward because it has four sources: the song's own record,
 * the job holding the machine, the queue behind it, and whether the stems
 * have been read into memory yet. Working that out in a component would mean
 * working it out twice, differently, so it is done here and tested.
 */

export type AnalysisPhase = 'none' | 'waiting' | 'running' | 'paused' | 'failed' | 'ready';

export interface AnalysisView {
  readonly phase: AnalysisPhase;
  /** How far along, 0 to 1, or null while there is nothing to show. */
  readonly share: number | null;
  readonly etaMs: number | null;
  /** Place among the waiting, 1 for next up. */
  readonly place: number | null;
  /** Other songs queued behind this one. */
  readonly behind: number;
}

/** Segments done as a fraction, or null before the worker has counted them. */
export function analysisShare(done: number, total: number): number | null {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, done / total));
}

export interface StageAnalysisInput {
  /** The record's status, or null for a file that has no record yet. */
  readonly status: SongStatus | null;
  /** The job holding the machine, whichever song it belongs to. */
  readonly job: AnalysisJob | null;
  readonly queue: JobQueue<AnalysisItem>;
  /** The key this file was queued under, when it was picked in this tab. */
  readonly key: string | null;
  readonly songId: string | null;
}

/**
 * Whether a queued job belongs to the song on the stage.
 *
 * Two ways, because a file picked a moment ago has a key and no record id,
 * and a song reopened from the drawer has a record id and no key.
 */
function stagedBy(input: StageAnalysisInput): (item: AnalysisItem) => boolean {
  return (item) =>
    (input.key !== null && item.key === input.key) ||
    (input.songId !== null && item.songId === input.songId);
}

/**
 * A record left at `separating` belongs to a tab that closed mid-job, and a
 * cancelled one to somebody who stopped it. Either way the segments already
 * written are still on disk, so both read as paused rather than broken.
 */
function phaseForStatus(status: SongStatus | null): AnalysisPhase {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'separating':
      return 'paused';
    case null:
      return 'none';
  }
}

export function stageAnalysis(input: StageAnalysisInput): AnalysisView {
  const mine = stagedBy(input);
  const behind = input.queue.waiting.filter((item) => !mine(item)).length;
  const job = input.job;

  if (job !== null && mine(job)) {
    return {
      phase: 'running',
      share: analysisShare(job.segmentsDone, job.segmentsTotal),
      etaMs: job.etaMs,
      place: null,
      behind,
    };
  }

  const place = placeInQueue(input.queue, mine);
  if (place !== null) {
    return { phase: 'waiting', share: null, etaMs: null, place, behind };
  }

  return { phase: phaseForStatus(input.status), share: null, etaMs: null, place: null, behind };
}

/** One line for the chip. Counts and times only: no file names, no words. */
export function describeAnalysis(view: AnalysisView): string {
  const behind = view.behind === 0 ? '' : `, ${String(view.behind)} more queued`;
  switch (view.phase) {
    case 'running': {
      const far = view.share === null ? 'analysing' : `analysing ${formatPercent(view.share)}`;
      const left = view.etaMs === null ? '' : `, about ${formatEta(view.etaMs)} left`;
      return `${far}${left}${behind}`;
    }
    case 'waiting':
      return view.place === null
        ? `queued for analysis${behind}`
        : `queued for analysis, number ${String(view.place)}${behind}`;
    case 'paused':
      return 'analysis stopped, and what it got through is kept';
    case 'failed':
      return 'analysis did not finish';
    case 'ready':
      return 'analysed';
    case 'none':
      return 'not analysed';
  }
}

export interface VocalToggle {
  readonly enabled: boolean;
  /** What the control says for itself, and why it cannot be pressed yet. */
  readonly label: string;
}

/**
 * Whether the voice can be taken out yet.
 *
 * Two gates, not one: the song has to have been separated, and its stems have
 * to have been read back into memory, which takes a moment of its own on a
 * four-minute song. The toggle stays where it is through both and says which
 * one it is waiting on, rather than appearing out of nowhere when both pass.
 */
export function vocalToggle(view: AnalysisView, stems: StemMixState): VocalToggle {
  if (stems === 'ready') {
    return { enabled: true, label: 'the instrumental is ready' };
  }
  if (stems === 'failed') {
    return { enabled: false, label: 'the stems for this song could not be played' };
  }
  if (view.phase === 'ready') {
    return { enabled: false, label: 'reading the stems off this device' };
  }
  return { enabled: false, label: `taking the voice out needs analysis: ${describeAnalysis(view)}` };
}
