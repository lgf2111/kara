import { useCallback, useEffect, useRef, useState } from 'react';

import { chooseBackend } from './separation/backend-choice.ts';
import type { BackendRequest } from './separation/backend-policy.ts';
import { SEGMENT_SAMPLES } from './separation/htdemucs.ts';
import { jobIdFor, jobPaths, planJob, type JobSource } from './separation/job.ts';
import type { Backend, SeparationMessage, SeparationResult } from './separation/protocol.ts';
import { blockWebgpu } from './separation/webgpu-memo.ts';
import { createOpfsStore } from './storage/opfs-store.ts';

/** The element the automation driver puts a local file into. */
const FILE_INPUT_ID = 'pipeline-file';

interface Loaded {
  readonly source: JobSource;
  readonly channels: Float32Array[];
}

interface RunOptions {
  readonly url?: string;
  /** `auto` leaves it to the policy, which is what a person gets. */
  readonly backend?: BackendRequest;
  readonly overlap: number;
  readonly maxSegments: number | null;
  readonly stems?: 'pair' | 'all';
  readonly optimisation?: 'disabled' | 'basic' | 'extended' | 'all';
}

interface Snapshot {
  readonly stage: string;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly etaMs: number | null;
  readonly resumedFrom: number;
  readonly backend: Backend;
}

/**
 * The phase hook the Playwright driver installs. Whether it exists is also how
 * the page tells being driven from being clicked.
 */
function automationHook(): ((name: string, detail?: unknown) => void) | undefined {
  const hook = (globalThis as unknown as Record<string, unknown>)['karaPhase'];
  return typeof hook === 'function'
    ? (hook as (name: string, detail?: unknown) => void)
    : undefined;
}

function report(name: string, detail?: unknown): void {
  console.log(`[pipeline] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  automationHook()?.(name, detail);
}

/** Decoding needs no audio output device, so an OfflineAudioContext is right. */
async function decode(bytes: ArrayBuffer, name: string): Promise<Loaded> {
  // decodeAudioData takes ownership of the buffer and detaches it, after which
  // byteLength reads 0. The job identity depends on this number, so take it
  // first.
  const byteLength = bytes.byteLength;
  report('decode-start', { bytes: byteLength, name });
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
  const buffer = await context.decodeAudioData(bytes);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(buffer.getChannelData(channel).slice());
  }
  const source: JobSource = {
    name,
    bytes: byteLength,
    sampleRate: buffer.sampleRate,
    samples: buffer.length,
  };
  report('decode-done', { seconds: Number((buffer.length / buffer.sampleRate).toFixed(2)) });
  return { source, channels };
}

/**
 * Decodes a chosen file, labelling a failure so the driver knows to retry
 * through ffmpeg. Chrome accepts more containers than it can decode, and an
 * mp4 whose audio it will not touch is the common case.
 */
async function decodeFile(file: File): Promise<Loaded> {
  try {
    return await decode(await file.arrayBuffer(), file.name);
  } catch (cause) {
    throw new Error(`decode-failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

function formatSeconds(ms: number | null): string {
  return ms === null ? 'unknown' : `${(ms / 1000).toFixed(0)} s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

/**
 * Base64 for handing a slice of a stem to the automation driver, which is the
 * only way bytes leave the browser sandbox for a local tool to pick up. Built
 * in small pieces because spreading a megabyte into `String.fromCharCode`
 * overflows the argument list.
 */
function toBase64(bytes: Uint8Array): string {
  const step = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export function PipelineApp() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The policy decides: WebGPU where the adapter has shader-f16, WASM
  // otherwise. `?backend=wasm` overrules it for a measurement.
  const [backend, setBackend] = useState<BackendRequest>('auto');
  const [segmentCap, setSegmentCap] = useState('0');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [result, setResult] = useState<SeparationResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageBytes, setStorageBytes] = useState<number | null>(null);
  const worker = useRef<Worker | null>(null);
  const audio = useRef<AudioContext | null>(null);

  const refreshStorage = useCallback(async () => {
    setStorageBytes(await createOpfsStore().usedBytes());
  }, []);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const run = useCallback(
    async (options: RunOptions, input: Loaded): Promise<SeparationResult> => {
      setBusy(true);
      setError(null);
      setResult(null);
      setNotice(null);
      const choice = await chooseBackend(location.search, options.backend ?? 'auto');
      report('backend-chosen', choice);
      report('run-start', { backend: choice.backend, maxSegments: options.maxSegments });

      const child = new Worker(new URL('./separation/separate.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.current = child;

      const channels = input.channels.map((channel) => new Float32Array(channel));
      const outcome = await new Promise<{ result: SeparationResult | null; error: string | null }>(
        (resolve) => {
          child.addEventListener('message', (event: MessageEvent<SeparationMessage>) => {
            const message = event.data;
            if (message.kind === 'progress' && message.notice !== null) {
              // A backend was abandoned mid-job. Say so once, in a person's
              // words, and remember it so the next song does not try again.
              report(message.stage, { backend: message.backend });
              blockWebgpu(message.stage);
              setNotice(message.notice);
              return;
            }
            if (message.kind === 'progress') {
              report(message.stage, {
                done: message.segmentsDone,
                total: message.segmentsTotal,
                etaMs: message.etaMs === null ? null : Math.round(message.etaMs),
                resumedFrom: message.resumedFrom,
                sumError:
                  message.stemSumError === null ? null : Number(message.stemSumError.toFixed(5)),
              });
              setSnapshot(message);
              return;
            }
            if (message.kind === 'done' || message.kind === 'cancelled') {
              report(message.kind, { segmentsDone: message.result.segmentsDone });
              resolve({ result: message.result, error: null });
              return;
            }
            report('failed', { stage: message.stage, error: message.error });
            resolve({ result: null, error: `${message.stage}: ${message.error}` });
          });
          child.addEventListener('error', (event) => {
            resolve({ result: null, error: event.message });
          });
          child.postMessage(
            {
              kind: 'start',
              backend: choice.backend,
              source: input.source,
              audio: { sampleRate: input.source.sampleRate, channels },
              overlap: options.overlap,
              maxSegments: options.maxSegments,
              stems: options.stems ?? 'pair',
              optimisation: options.optimisation ?? 'all',
            },
            channels.map((channel) => channel.buffer),
          );
        },
      );

      child.terminate();
      worker.current = null;
      setBusy(false);
      setResult(outcome.result);
      setError(outcome.error);
      await refreshStorage();
      if (outcome.result === null) {
        throw new Error(outcome.error ?? 'separation failed');
      }
      return outcome.result;
    },
    [refreshStorage],
  );

  const cancel = useCallback(() => {
    report('cancel-requested');
    worker.current?.postMessage({ kind: 'cancel' });
  }, []);

  // Automation entry point. The page drives itself the same way, so there is
  // one code path rather than two.
  useEffect(() => {
    const api = {
      async run(options: RunOptions): Promise<SeparationResult> {
        const url = options.url ?? '/spike-fixtures/tone-240s.wav';
        const response = await fetch(url);
        const bytes = await response.arrayBuffer();
        const input = await decode(bytes, url.slice(url.lastIndexOf('/') + 1));
        setLoaded(input);
        return run(options, input);
      },
      /**
       * Separates whatever file is sitting in the page's file input. This is
       * how a real local file arrives: the driver sets it with
       * `setInputFiles` and the browser decodes it, exactly as it would for a
       * person choosing the file by hand. Nothing is uploaded or copied.
       */
      async runFile(options: RunOptions): Promise<SeparationResult> {
        const element = document.getElementById(FILE_INPUT_ID);
        const file = element instanceof HTMLInputElement ? element.files?.[0] : undefined;
        if (file === undefined) {
          throw new Error('no file is selected on the page');
        }
        const input = await decodeFile(file);
        setLoaded(input);
        return run(options, input);
      },
      cancel,
      async jobState(name: string, bytes: number, samples: number): Promise<unknown> {
        const source: JobSource = { name, bytes, sampleRate: 44100, samples };
        return createOpfsStore().readJson(jobPaths(jobIdFor(source)).state);
      },
      async stemSizes(name: string, bytes: number, samples: number): Promise<Record<string, number | null>> {
        const store = createOpfsStore();
        const paths = jobPaths(jobIdFor({ name, bytes, sampleRate: 44100, samples }));
        return {
          vocals: await store.sizeOf(paths.stem('vocals')),
          instrumental: await store.sizeOf(paths.stem('instrumental')),
        };
      },
      /** One slice of a finished stem, for the driver to write out as WAV. */
      async readStemChunk(path: string, offset: number, length: number): Promise<string> {
        const bytes = await createOpfsStore().readBytes(path, offset, length);
        if (bytes === null) {
          throw new Error(`no stem at ${path}`);
        }
        return toBase64(bytes);
      },
      async clear(): Promise<void> {
        await createOpfsStore().remove('songs');
      },
    };
    (globalThis as unknown as Record<string, unknown>)['karaPipeline'] = api;
    report('page-ready', { crossOriginIsolated });
  }, [cancel, run]);

  const play = useCallback(async (path: string) => {
    audio.current ??= new AudioContext();
    const context = audio.current;
    await context.resume();
    const interleaved = await createOpfsStore().readFloat32(path);
    if (interleaved === null) {
      return;
    }
    const frames = Math.floor(interleaved.length / 2);
    const buffer = context.createBuffer(2, frames, 44100);
    for (let channel = 0; channel < 2; channel += 1) {
      const target = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i += 1) {
        target[i] = interleaved[i * 2 + channel] ?? 0;
      }
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    node.start();
  }, []);

  const plan = loaded === null ? null : planJob(loaded.source.samples, SEGMENT_SAMPLES, 0.25);

  return (
    <main className="spike">
      <h1>Kara separation pipeline</h1>
      <p className="warn">
        Development page. Your file is decoded and separated in this tab and never uploaded.
      </p>

      <section>
        <h2>Input</h2>
        <input
          id={FILE_INPUT_ID}
          type="file"
          accept="audio/*,video/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) {
              return;
            }
            if (automationHook() !== undefined) {
              // The driver fills this input and then calls runFile, which
              // decodes. Decoding here too would do the work twice and hold
              // two copies of the audio, which this target cannot spare.
              return;
            }
            void file
              .arrayBuffer()
              .then((bytes) => decode(bytes, file.name))
              .then(setLoaded)
              .catch((cause: unknown) => setError(String(cause)));
          }}
        />
        {loaded !== null && plan !== null && (
          <p>
            {loaded.source.name}: {(loaded.source.samples / loaded.source.sampleRate).toFixed(1)} s,{' '}
            {loaded.source.sampleRate} Hz, {loaded.channels.length} ch, {plan.total} segments of{' '}
            {(plan.segment / loaded.source.sampleRate).toFixed(2)} s with{' '}
            {(plan.fade / loaded.source.sampleRate).toFixed(2)} s overlap
          </p>
        )}
      </section>

      <section>
        <h2>Run</h2>
        <label>
          Backend{' '}
          <select
            value={backend}
            onChange={(event) => setBackend(event.target.value as BackendRequest)}
          >
            <option value="auto">auto (webgpu where it works)</option>
            <option value="webgpu">webgpu</option>
            <option value="wasm">wasm</option>
          </select>
        </label>
        <label>
          Segment cap (0 for all){' '}
          <input
            type="number"
            min="0"
            value={segmentCap}
            onChange={(event) => setSegmentCap(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || loaded === null}
          onClick={() => {
            if (loaded === null) {
              return;
            }
            const cap = Number(segmentCap);
            void run(
              { backend, overlap: 0.25, maxSegments: Number.isFinite(cap) && cap > 0 ? cap : null },
              loaded,
            ).catch(() => undefined);
          }}
        >
          {busy ? 'separating' : 'separate'}
        </button>
        <button type="button" disabled={!busy} onClick={cancel}>
          cancel
        </button>
      </section>

      {snapshot !== null && (
        <section>
          <h2>Progress</h2>
          <p>
            {snapshot.stage} on {snapshot.backend}: {snapshot.segmentsDone}/
            {snapshot.segmentsTotal}
            {snapshot.resumedFrom > 0 ? ` (resumed from ${snapshot.resumedFrom})` : ''}
          </p>
          <p>About {formatSeconds(snapshot.etaMs)} left</p>
        </section>
      )}

      {notice !== null && (
        <section>
          <h2>Notice</h2>
          <p className="warn">{notice}</p>
        </section>
      )}

      {error !== null && (
        <section>
          <h2>Failed</h2>
          <pre>{error}</pre>
        </section>
      )}

      {result !== null && (
        <section>
          <h2>Result</h2>
          <dl>
            <dt>Job</dt>
            <dd>{result.jobId}</dd>
            <dt>Backend</dt>
            <dd>
              {result.backend}
              {result.fellBackFrom === null ? '' : ` (after ${result.fellBackFrom} was dropped)`}
            </dd>
            <dt>Segments</dt>
            <dd>
              {result.segmentsDone}/{result.segmentsTotal}
              {result.resumedFrom > 0 ? `, resumed from ${result.resumedFrom}` : ''}
            </dd>
            <dt>Model load</dt>
            <dd>{(result.loadMs / 1000).toFixed(2)} s</dd>
            <dt>Inference</dt>
            <dd>{(result.inferenceMs / 1000).toFixed(1)} s</dd>
            <dt>Audio written</dt>
            <dd>{result.audioSeconds.toFixed(1)} s</dd>
            <dt>Stems add back to the mix within</dt>
            <dd>
              {result.stemSumError === null
                ? 'not measured'
                : `${(result.stemSumError * 100).toFixed(2)}%`}
            </dd>
          </dl>
          <p>
            {result.stems.map((stem) => (
              <button
                key={stem.name}
                type="button"
                onClick={() => {
                  void play(stem.path);
                }}
              >
                play {stem.name} ({formatBytes(stem.bytes)})
              </button>
            ))}
          </p>
        </section>
      )}

      <section>
        <h2>Storage</h2>
        <p>{storageBytes === null ? 'unknown' : formatBytes(storageBytes)} used in this origin</p>
        <button
          type="button"
          onClick={() => {
            void createOpfsStore()
              .remove('songs')
              .then(refreshStorage);
          }}
        >
          delete all songs
        </button>
      </section>
    </main>
  );
}
