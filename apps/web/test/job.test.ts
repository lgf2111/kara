import { describe, expect, it } from 'vitest';

import {
  JOB_SCHEMA,
  decideResume,
  estimateRemainingMs,
  jobIdFor,
  jobPaths,
  loadJob,
  medianMs,
  planJob,
  saveJob,
  sameSource,
  type JobSource,
  type JobState,
} from '../src/separation/job.ts';
import { SEGMENT_SAMPLES } from '../src/separation/htdemucs.ts';
import { createMemoryStore } from '../src/storage/store.ts';

const source: JobSource = {
  name: 'tone-240s.wav',
  bytes: 42336078,
  sampleRate: 44100,
  samples: 10584000,
};

const plan = planJob(source.samples, SEGMENT_SAMPLES, 0.25);

function state(overrides: Partial<JobState> = {}): JobState {
  return {
    schema: JOB_SCHEMA,
    jobId: jobIdFor(source),
    model: 'htdemucs-web',
    source,
    plan,
    segmentsDone: 10,
    samplesWritten: 10 * plan.stride,
    stems: ['vocals', 'instrumental'],
    status: 'running',
    updatedAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

function stemBytes(samples: number): Record<string, number> {
  const bytes = samples * 2 * 4;
  return { vocals: bytes, instrumental: bytes };
}

describe('planJob', () => {
  it('covers the whole input with overlapping segments', () => {
    expect(plan.segment).toBe(SEGMENT_SAMPLES);
    expect(plan.stride).toBe(Math.round(SEGMENT_SAMPLES * 0.75));
    expect(plan.fade).toBe(SEGMENT_SAMPLES - plan.stride);
    // The last segment must reach the end of the audio.
    expect((plan.total - 1) * plan.stride + plan.segment).toBeGreaterThanOrEqual(source.samples);
  });

  it('always plans at least one segment', () => {
    expect(planJob(10, SEGMENT_SAMPLES, 0.25).total).toBe(1);
  });
});

describe('jobIdFor', () => {
  it('is stable for the same file and differs for a different one', () => {
    expect(jobIdFor(source)).toBe(jobIdFor({ ...source }));
    expect(jobIdFor(source)).not.toBe(jobIdFor({ ...source, bytes: source.bytes + 1 }));
  });

  it('keeps the id usable as a path segment', () => {
    expect(jobIdFor({ ...source, name: 'my song/../weird name.wav' })).not.toContain('/');
  });
});

describe('sameSource', () => {
  it('rejects any difference that would change the audio', () => {
    expect(sameSource(source, { ...source })).toBe(true);
    expect(sameSource(source, { ...source, samples: 1 })).toBe(false);
    expect(sameSource(source, { ...source, sampleRate: 48000 })).toBe(false);
    expect(sameSource(source, { ...source, bytes: 1 })).toBe(false);
    expect(sameSource(source, { ...source, name: 'other.wav' })).toBe(false);
  });
});

describe('decideResume', () => {
  it('starts fresh with nothing saved', () => {
    expect(decideResume(null, source, plan, {}).from).toBe(0);
  });

  it('resumes from the next segment when everything matches', () => {
    const decision = decideResume(state(), source, plan, stemBytes(10 * plan.stride));
    expect(decision.from).toBe(10);
    expect(decision.samplesWritten).toBe(10 * plan.stride);
  });

  it('restarts when the file is different', () => {
    const decision = decideResume(state(), { ...source, bytes: 99 }, plan, stemBytes(10 * plan.stride));
    expect(decision.from).toBe(0);
    expect(decision.reason).toContain('different file');
  });

  it('restarts when the segment plan changed', () => {
    const other = planJob(source.samples, SEGMENT_SAMPLES, 0.5);
    const decision = decideResume(state(), source, other, stemBytes(10 * plan.stride));
    expect(decision.from).toBe(0);
    expect(decision.reason).toContain('segment plan');
  });

  it('restarts when a stem is shorter than the state claims', () => {
    const decision = decideResume(state(), source, plan, stemBytes(10 * plan.stride - 1));
    expect(decision.from).toBe(0);
    expect(decision.reason).toContain('bytes');
  });

  it('restarts when a stem is missing entirely', () => {
    const decision = decideResume(state(), source, plan, { vocals: null, instrumental: null });
    expect(decision.from).toBe(0);
  });

  it('tolerates a stem with extra bytes, which get trimmed', () => {
    const generous = stemBytes(10 * plan.stride + 1000);
    expect(decideResume(state(), source, plan, generous).from).toBe(10);
  });

  it('reports a finished job as complete', () => {
    const decision = decideResume(
      state({ status: 'done', segmentsDone: plan.total }),
      source,
      plan,
      stemBytes(10 * plan.stride),
    );
    expect(decision.from).toBe(plan.total);
  });

  it('resumes a cancelled job, because cancelling is not discarding', () => {
    const decision = decideResume(
      state({ status: 'cancelled' }),
      source,
      plan,
      stemBytes(10 * plan.stride),
    );
    expect(decision.from).toBe(10);
  });

  it('ignores a saved job from another schema version', () => {
    const decision = decideResume(
      { ...state(), schema: 'kara-job/0' },
      source,
      plan,
      stemBytes(10 * plan.stride),
    );
    expect(decision.reason).toContain('schema');
  });
});

describe('estimateRemainingMs', () => {
  it('uses the median segment time', () => {
    expect(medianMs([100, 200, 300])).toBe(200);
    expect(estimateRemainingMs([100, 200, 300], 4)).toBe(800);
  });

  it('has no estimate before the first segment', () => {
    expect(estimateRemainingMs([], 10)).toBeNull();
  });
});

describe('job state round trip', () => {
  it('saves and loads through a store', async () => {
    const store = createMemoryStore();
    await saveJob(store, state());

    const loaded = await loadJob(store, jobIdFor(source));

    expect(decideResume(loaded, source, plan, stemBytes(10 * plan.stride)).from).toBe(10);
    expect(await store.list('songs/')).toContain(jobPaths(jobIdFor(source)).state);
  });
});

describe('memory store', () => {
  it('appends, reports size, truncates and removes', async () => {
    const store = createMemoryStore();
    const file = await store.openAppend('songs/x/vocals.f32');

    await file.append(Float32Array.from([1, 2]));
    await file.append(Float32Array.from([3]));
    expect(file.size()).toBe(12);

    await file.truncate(8);
    expect(file.size()).toBe(8);
    expect([...((await store.readFloat32('songs/x/vocals.f32')) ?? [])]).toEqual([1, 2]);

    expect(await store.usedBytes()).toBe(8);
    await store.remove('songs/x');
    expect(await store.list('songs/')).toEqual([]);
  });

  it('reads a byte range, which is how a stem is copied out', async () => {
    const store = createMemoryStore();
    await store.writeFloat32('songs/x/vocals.f32', Float32Array.from([1, 2, 3, 4]));

    const middle = await store.readBytes('songs/x/vocals.f32', 4, 8);

    expect(middle?.byteLength).toBe(8);
    expect([...new Float32Array(middle?.slice().buffer ?? new ArrayBuffer(0))]).toEqual([2, 3]);
  });

  it('clips a range that runs past the end', async () => {
    const store = createMemoryStore();
    await store.writeFloat32('songs/x/vocals.f32', Float32Array.from([1, 2]));

    expect((await store.readBytes('songs/x/vocals.f32', 4, 999))?.byteLength).toBe(4);
    expect((await store.readBytes('songs/x/vocals.f32', 8, 4))?.byteLength).toBe(0);
  });

  it('returns null for files it does not have', async () => {
    const store = createMemoryStore();
    expect(await store.readFloat32('nope')).toBeNull();
    expect(await store.readJson('nope')).toBeNull();
    expect(await store.sizeOf('nope')).toBeNull();
    expect(await store.readBytes('nope', 0, 8)).toBeNull();
  });
});
