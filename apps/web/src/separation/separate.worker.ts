/// <reference lib="webworker" />
import { FALLBACK_NOTICE, FALLBACK_STAGE, checkSegment } from './backend-guard.ts';
import { SEGMENT_SAMPLES, SOURCES } from './htdemucs.ts';
import {
  JOB_SCHEMA,
  decideResume,
  estimateRemainingMs,
  jobIdFor,
  jobPaths,
  loadJob,
  planJob,
  saveJob,
  type JobState,
} from './job.ts';
import type { SegmentRun } from './segment-contract.ts';
import { MODEL_ID, createSegmentRunner } from './segment-runner.ts';
import { createStitcher, type Stitcher } from './stitch.ts';
import type {
  Backend,
  CancelledMessage,
  DoneMessage,
  FailedMessage,
  ProgressMessage,
  SeparationRequest,
  SeparationResult,
  StartMessage,
  StemFile,
} from './protocol.ts';
import { reasonText } from '../notices/notices.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';

let cancelRequested = false;

function post(message: ProgressMessage | DoneMessage | CancelledMessage | FailedMessage): void {
  self.postMessage(message);
}

/**
 * What one attempt at a job came to. A backend that returns garbage is not a
 * failure to report: it is an attempt that has to be made again elsewhere, and
 * the guard sees to it that nothing was written before this is decided.
 */
type Attempt =
  | { readonly outcome: 'result'; readonly result: SeparationResult }
  | { readonly outcome: 'fallback'; readonly reason: string };

async function separate(
  request: StartMessage,
  backend: Backend,
  fellBackFrom: Backend | null = null,
): Promise<Attempt> {
  const startedAt = performance.now();
  const store = createOpfsStore();
  const hostMs: Record<string, number> = {};
  const diagnostics: Record<string, string | number> = {};
  const addStage = (name: string, ms: number): void => {
    hostMs[name] = (hostMs[name] ?? 0) + ms;
  };
  const stage = (name: string, since: number): void => {
    addStage(name, performance.now() - since);
  };

  const source = request.source;
  const jobId = jobIdFor(source);
  const paths = jobPaths(jobId);
  const plan = planJob(source.samples, SEGMENT_SAMPLES, request.overlap);
  // 'all' keeps each source as its own file as well as the summed
  // instrumental, so separation can be judged one instrument at a time. The
  // player only ever needs the pair, so that stays the default.
  const writeAllStems = request.stems === 'all';
  const stemNames: readonly string[] = writeAllStems
    ? [...SOURCES, 'instrumental']
    : ['vocals', 'instrumental'];

  const stemSizes: Record<string, number | null> = {};
  for (const name of stemNames) {
    stemSizes[name] = await store.sizeOf(paths.stem(name));
  }
  const resume = decideResume(await loadJob(store, jobId), source, plan, stemSizes);
  post({
    kind: 'progress',
    stage: `plan: ${resume.reason}`,
    segmentsDone: resume.from,
    segmentsTotal: plan.total,
    etaMs: null,
    resumedFrom: resume.from,
    stemSumError: null,
    backend,
    notice: null,
  });

  const total = request.maxSegments === null ? plan.total : Math.min(plan.total, request.maxSegments);

  // Model first: a resume that cannot load the model should not touch stems.
  const loadStart = performance.now();
  const runner = await createSegmentRunner({
    backend,
    optimisation: request.optimisation ?? 'all',
    onPiece: (loaded, pieces) => {
      post({
        kind: 'progress',
        stage: 'loading model',
        segmentsDone: loaded,
        segmentsTotal: pieces,
        etaMs: null,
        resumedFrom: resume.from,
        stemSumError: null,
        backend,
        notice: null,
      });
    },
    onStage: addStage,
  });
  diagnostics['fp32Islands'] = runner.islands;
  const loadMs = performance.now() - loadStart;

  const left = request.audio.channels[0] ?? new Float32Array(source.samples);
  const right = request.audio.channels[1] ?? left;

  /** Which of a run's buffers a stem file takes its samples from. */
  const freshFor = (name: string, run: SegmentRun): Float32Array => {
    if (name === 'vocals') {
      return run.vocals;
    }
    if (name === 'instrumental') {
      return run.instrumental;
    }
    const index = SOURCES.findIndex((stem) => stem === name);
    const buffer = index < 0 ? undefined : run.stems[index];
    if (buffer === undefined) {
      throw new Error(`no segment buffer for stem ${name}`);
    }
    return buffer;
  };

  interface StemState {
    readonly name: string;
    readonly file: Awaited<ReturnType<typeof store.openAppend>>;
    readonly stitcher: Stitcher;
  }

  const stemStates: StemState[] = [];
  for (const name of stemNames) {
    const file = await store.openAppend(paths.stem(name));
    await file.truncate(resume.samplesWritten * 2 * Float32Array.BYTES_PER_ELEMENT);
    const stitcher = createStitcher(plan, 2);
    if (resume.from > 0) {
      const saved = await store.readFloat32(paths.tail(name));
      if (saved === null) {
        throw new Error(`resume state is missing the crossfade tail for ${name}`);
      }
      stitcher.restore(saved);
    }
    stemStates.push({ name, file, stitcher });
  }

  const segmentMs: number[] = [];
  let inferenceMs = 0;
  let samplesWritten = resume.samplesWritten;
  let segmentsDone = resume.from;
  let stemSumError: number | null = null;
  const stemSumErrors: number[] = [];
  let cancelled = false;
  let guarded = false;
  let fallback: string | null = null;

  const persist = async (status: JobState['status']): Promise<void> => {
    for (const stem of stemStates) {
      if (stem.stitcher.hasTail()) {
        await store.writeFloat32(paths.tail(stem.name), stem.stitcher.tail);
      }
    }
    await saveJob(store, {
      schema: JOB_SCHEMA,
      jobId,
      model: MODEL_ID,
      source,
      plan,
      segmentsDone,
      samplesWritten,
      stems: [...stemNames],
      status,
      updatedAt: new Date().toISOString(),
    });
  };

  for (let index = resume.from; index < total; index += 1) {
    if (cancelRequested) {
      cancelled = true;
      break;
    }
    const start = index * plan.stride;

    // Past the end of the input the subarray comes back short and the runner
    // zero-pads it, which is the padding demucs applies to a final chunk.
    const run = await runner.run(
      left.subarray(start, start + SEGMENT_SAMPLES),
      right.subarray(start, start + SEGMENT_SAMPLES),
      index === resume.from ? diagnostics : null,
    );
    segmentMs.push(run.inferenceMs);
    inferenceMs += run.inferenceMs;

    stemSumError = run.stemSumError;
    if (stemSumError !== null) {
      stemSumErrors.push(stemSumError);
    }

    // The first segment of a run is the last moment at which nothing has been
    // written, and a backend that miscompiles this graph miscompiles it on
    // every segment. So this is where the backend is believed or dropped.
    if (!guarded) {
      guarded = true;
      const decision = checkSegment(backend, { nonFinite: run.nonFinite, stemSumError });
      diagnostics['guard'] = decision.action;
      if (decision.action === 'fall-back-to-wasm') {
        fallback = decision.reason;
        break;
      }
      if (decision.action === 'stop') {
        throw new Error(decision.reason);
      }
    }

    const writeAt = performance.now();
    const isLast = index === total - 1;
    let releasedFrames = 0;
    for (const stem of stemStates) {
      const chunk = stem.stitcher.push(freshFor(stem.name, run));
      if (chunk !== null) {
        await stem.file.append(chunk);
        releasedFrames = chunk.length / 2;
      }
      if (isLast) {
        await stem.file.append(stem.stitcher.finish());
      }
    }
    samplesWritten += releasedFrames + (isLast ? plan.segment : 0);
    stage('write', writeAt);

    segmentsDone = index + 1;
    await persist(isLast ? 'done' : 'running');

    post({
      kind: 'progress',
      stage: 'separating',
      segmentsDone,
      segmentsTotal: total,
      etaMs: estimateRemainingMs(segmentMs, total - segmentsDone),
      resumedFrom: resume.from,
      stemSumError,
      backend,
      notice: null,
    });
  }

  if (cancelled) {
    await persist('cancelled');
  }

  // Closed before anything else can happen: a sync access handle holds an
  // exclusive lock, so a retry on another backend cannot reopen these stems
  // until this attempt has let them go.
  const stems: StemFile[] = [];
  for (const stem of stemStates) {
    const bytes = stem.file.size();
    await stem.file.close();
    stems.push({ name: stem.name, path: paths.stem(stem.name), bytes });
  }

  await runner.release();

  if (fallback !== null) {
    return { outcome: 'fallback', reason: fallback };
  }

  return {
    outcome: 'result',
    result: {
      jobId,
      backend,
      fellBackFrom,
      resumedFrom: resume.from,
      segmentsDone,
      segmentsTotal: total,
      loadMs,
      inferenceMs,
      segmentMs,
      hostMs,
      totalMs: performance.now() - startedAt,
      audioSeconds: samplesWritten / source.sampleRate,
      samplesWritten,
      stems,
      stemSumError,
      stemSumErrors,
      diagnostics,
    },
  };
}

self.addEventListener('message', (event: MessageEvent<SeparationRequest>) => {
  const request = event.data;
  if (request.kind === 'cancel') {
    cancelRequested = true;
    return;
  }
  void (async () => {
    try {
      const finish = (result: SeparationResult): void => {
        post(cancelRequested ? { kind: 'cancelled', result } : { kind: 'done', result });
      };

      const first = await separate(request, request.backend);
      if (first.outcome === 'result') {
        finish(first.result);
        return;
      }

      // The guard runs before the first segment is released, so WebGPU wrote
      // nothing and the same job can start again on WASM from the same place.
      // One retry only: WASM has nothing to fall back to, so a guard failure
      // there is a failure.
      post({
        kind: 'progress',
        stage: `${FALLBACK_STAGE}: ${first.reason}`,
        segmentsDone: 0,
        segmentsTotal: 0,
        etaMs: null,
        resumedFrom: 0,
        stemSumError: null,
        backend: 'wasm',
        notice: FALLBACK_NOTICE,
      });
      const second = await separate(request, 'wasm', request.backend);
      if (second.outcome !== 'result') {
        throw new Error(second.reason);
      }
      finish(second.result);
    } catch (error) {
      post({
        kind: 'failed',
        stage: 'separation',
        // The same wording the room will show, so a bare `Error:` does not
        // end up in front of the reason on its way to the notice.
        error: reasonText(error),
      });
    }
  })();
});
