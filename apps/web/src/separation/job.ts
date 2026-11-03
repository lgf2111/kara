import type { Store } from '../storage/store.ts';

/**
 * A separation job that survives the tab closing.
 *
 * After every segment the pipeline writes three things: the finished audio
 * appended to each stem, the pending tail each stem still needs in order to
 * crossfade into the next segment, and a small state file. Reopening reads the
 * state back, checks it still describes the same input, trims any half-written
 * bytes, and carries on from the next segment.
 */

export const JOB_SCHEMA = 'kara-job/1';

export interface JobSource {
  readonly name: string;
  readonly bytes: number;
  readonly sampleRate: number;
  readonly samples: number;
}

export interface JobPlan {
  /** Samples per model segment. */
  readonly segment: number;
  /** Samples between segment starts. */
  readonly stride: number;
  /** Samples two neighbouring segments share. */
  readonly fade: number;
  readonly total: number;
}

export type JobStatus = 'running' | 'cancelled' | 'done';

export interface JobState {
  readonly schema: typeof JOB_SCHEMA;
  readonly jobId: string;
  readonly model: string;
  readonly source: JobSource;
  readonly plan: JobPlan;
  readonly segmentsDone: number;
  /** Frames (not bytes) already final in every stem. */
  readonly samplesWritten: number;
  readonly stems: readonly string[];
  readonly status: JobStatus;
  readonly updatedAt: string;
}

export function planJob(samples: number, segment: number, overlap: number): JobPlan {
  const stride = Math.max(1, Math.round(segment * (1 - overlap)));
  let total = 0;
  for (let start = 0; start < samples; start += stride) {
    total += 1;
    if (start + segment >= samples) {
      break;
    }
  }
  return { segment, stride, fade: segment - stride, total: Math.max(1, total) };
}

export interface JobPaths {
  readonly directory: string;
  readonly state: string;
  readonly stem: (name: string) => string;
  readonly tail: (name: string) => string;
}

export function jobPaths(jobId: string): JobPaths {
  const directory = `songs/${jobId}`;
  return {
    directory,
    state: `${directory}/job.json`,
    stem: (name) => `${directory}/${name}.f32`,
    tail: (name) => `${directory}/tail-${name}.f32`,
  };
}

/** Two sources are the same input if these all match. */
export function sameSource(a: JobSource, b: JobSource): boolean {
  return (
    a.name === b.name &&
    a.bytes === b.bytes &&
    a.sampleRate === b.sampleRate &&
    a.samples === b.samples
  );
}

function samePlan(a: JobPlan, b: JobPlan): boolean {
  return a.segment === b.segment && a.stride === b.stride && a.total === b.total;
}

export interface ResumeDecision {
  readonly from: number;
  readonly samplesWritten: number;
  readonly reason: string;
}

/**
 * Where to start, given whatever was saved. Anything unexpected restarts from
 * the beginning rather than risking a corrupt stem.
 */
export function decideResume(
  saved: unknown,
  source: JobSource,
  plan: JobPlan,
  stemBytes: Readonly<Record<string, number | null>>,
): ResumeDecision {
  const fresh: ResumeDecision = { from: 0, samplesWritten: 0, reason: 'no saved job' };
  if (saved === null || typeof saved !== 'object') {
    return fresh;
  }
  const state = saved as Partial<JobState>;
  if (state.schema !== JOB_SCHEMA) {
    return { from: 0, samplesWritten: 0, reason: 'saved job has a different schema' };
  }
  if (state.source === undefined || !sameSource(state.source, source)) {
    return { from: 0, samplesWritten: 0, reason: 'saved job describes a different file' };
  }
  if (state.plan === undefined || !samePlan(state.plan, plan)) {
    return { from: 0, samplesWritten: 0, reason: 'saved job used a different segment plan' };
  }
  if (state.status === 'done') {
    return {
      from: state.plan.total,
      samplesWritten: state.samplesWritten ?? 0,
      reason: 'saved job already finished',
    };
  }

  const segmentsDone = state.segmentsDone ?? 0;
  const samplesWritten = state.samplesWritten ?? 0;
  if (segmentsDone <= 0) {
    return fresh;
  }

  // The state file is written last, so a stem that is shorter than the state
  // claims means the write was interrupted. Shorter is not recoverable; longer
  // just means bytes past the mark, which get trimmed.
  const wanted = samplesWritten * 2 * Float32Array.BYTES_PER_ELEMENT;
  for (const name of state.stems ?? []) {
    const have = stemBytes[name];
    if (have === null || have === undefined || have < wanted) {
      return {
        from: 0,
        samplesWritten: 0,
        reason: `stem ${name} holds ${String(have ?? 0)} bytes but the job claims ${String(wanted)}`,
      };
    }
  }

  return {
    from: segmentsDone,
    samplesWritten,
    reason: `resuming after segment ${String(segmentsDone)} of ${String(state.plan.total)}`,
  };
}

export async function saveJob(store: Store, state: JobState): Promise<void> {
  await store.writeJson(jobPaths(state.jobId).state, state);
}

export async function loadJob(store: Store, jobId: string): Promise<unknown> {
  return store.readJson(jobPaths(jobId).state);
}

/** Median, which is steadier than a mean when one segment stalls. */
export function medianMs(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function estimateRemainingMs(segmentMs: readonly number[], remaining: number): number | null {
  const typical = medianMs(segmentMs);
  return typical > 0 ? typical * Math.max(0, remaining) : null;
}

/**
 * A stable identity for a file, so reopening the same file finds its job.
 * Deliberately not a hash of the audio: that would mean reading the whole file
 * before knowing whether there is anything to resume. M7's fingerprint is a
 * different thing for a different purpose.
 */
export function jobIdFor(source: JobSource): string {
  const name = source.name.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 48);
  return `${name}-${String(source.bytes)}-${String(source.samples)}`;
}
