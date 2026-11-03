import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fullSample } from './spike/memory.ts';
import {
  PAGES_FILE_LIMIT_BYTES,
  SEPARATION_MODELS,
  SPIKE_LANGUAGES,
  TRANSCRIPTION_MODELS,
} from './spike/models.ts';
import { clearStems, readStem } from './spike/opfs.ts';
import type {
  AudioPayload,
  Backend,
  MainThreadHealth,
  ProgressMessage,
  RunMode,
  RunResult,
  SpikeReport,
  WorkerMessage,
} from './spike/protocol.ts';

interface Loaded {
  readonly name: string;
  readonly synthetic: boolean;
  readonly sampleRate: number;
  readonly channels: Float32Array[];
}

interface RunOptions {
  readonly task: 'separation' | 'transcription';
  readonly modelId: string;
  readonly backend: Backend;
  readonly mode: RunMode;
  readonly maxSegments: number | null;
  readonly language: string;
}

/** Records how much the main thread stuttered while the worker was busy. */
function startHeartbeat(): () => MainThreadHealth {
  const gaps: number[] = [];
  let last = performance.now();
  let running = true;

  const tick = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (running) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);

  return () => {
    running = false;
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      frames: gaps.length,
      maxGapMs: gaps.length > 0 ? Math.max(...gaps) : 0,
      medianGapMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      longFrames: gaps.filter((gap) => gap > 50).length,
    };
  };
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return 'unavailable';
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Names the phase the page has entered. The Playwright harness installs
 * `karaPhase` and resets its stall watchdog on every call, so a hang is
 * attributed to a phase instead of to the run as a whole.
 */
function phase(name: string, detail?: unknown): void {
  console.log(`[spike] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  const report = (globalThis as unknown as Record<string, unknown>)['karaPhase'];
  if (typeof report === 'function') {
    (report as (name: string, detail?: unknown) => void)(name, detail);
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

async function describeWebGpu(): Promise<string | null> {
  const gpu = (navigator as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (gpu === undefined) {
    return null;
  }
  try {
    const adapter = (await gpu.requestAdapter()) as { info?: Record<string, string> } | null;
    if (adapter === null) {
      return null;
    }
    const info = adapter.info ?? {};
    const parts = [info['vendor'], info['architecture'], info['device'], info['description']].filter(
      (part) => part !== undefined && part !== '',
    );
    return parts.length > 0 ? parts.join(' ') : 'adapter available, no info exposed';
  } catch {
    return null;
  }
}

export function SpikeApp() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [task, setTask] = useState<'separation' | 'transcription'>('separation');
  const [modelId, setModelId] = useState<string>(SEPARATION_MODELS[0]?.id ?? '');
  const [language, setLanguage] = useState<string>('zh');
  const [backend, setBackend] = useState<Backend>('webgpu');
  const [mode, setMode] = useState<RunMode>('audio');
  const [segmentCap, setSegmentCap] = useState<string>('4');
  const [progress, setProgress] = useState<ProgressMessage | null>(null);
  const [report, setReport] = useState<SpikeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [webgpu, setWebgpu] = useState<string | null>(null);
  const audioContext = useRef<AudioContext | null>(null);

  useEffect(() => {
    void describeWebGpu().then(setWebgpu);
  }, []);

  const decode = useCallback(async (bytes: ArrayBuffer, name: string, synthetic: boolean): Promise<Loaded> => {
    // Decoding deliberately uses an OfflineAudioContext. A plain AudioContext
    // needs an audio output device, and in a headless browser it never leaves
    // the suspended state, which makes decodeAudioData hang forever with the
    // renderer idle. This cost 69 minutes of wall clock to find.
    // The context's rate is the rate the data comes back at, so asking for
    // 44.1 kHz also resamples anything else to what the models require.
    phase('decode-start', { bytes: bytes.byteLength, name });
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
    const buffer = await context.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel).slice());
    }
    phase('decode-done', {
      seconds: Number((buffer.length / buffer.sampleRate).toFixed(2)),
      sampleRate: buffer.sampleRate,
      channels: channels.length,
    });
    return { name, synthetic, sampleRate: buffer.sampleRate, channels };
  }, []);

  const run = useCallback(
    async (options: RunOptions, input: Loaded): Promise<SpikeReport> => {
      setBusy(true);
      setError(null);
      setProgress(null);
      phase('run-start', options);
      await clearStems();
      phase('opfs-cleared');

      const memoryBefore = await fullSample();
      phase('memory-sampled', { agentBytes: memoryBefore.agentBytes, jsHeapBytes: memoryBefore.jsHeapBytes });
      const stopHeartbeat = startHeartbeat();
      const startedAt = new Date().toISOString();

      const worker =
        options.task === 'transcription'
          ? new Worker(new URL('./spike/transcription.worker.ts', import.meta.url), { type: 'module' })
          : new Worker(new URL('./spike/separation.worker.ts', import.meta.url), { type: 'module' });
      phase('worker-created', { task: options.task });

      const payload: AudioPayload = {
        sampleRate: input.sampleRate,
        channels: input.channels.map((channel) => new Float32Array(channel)),
      };

      const outcome = await new Promise<{ result: RunResult | null; error: string | null }>((resolve) => {
        worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          if (message.kind === 'progress') {
            phase(message.stage, { done: message.done, total: message.total });
            setProgress(message);
            return;
          }
          if (message.kind === 'done') {
            phase('run-done');
            resolve({ result: message.result, error: null });
            return;
          }
          phase('run-failed', { stage: message.stage, error: message.error });
          resolve({ result: null, error: `${message.stage}: ${message.error}` });
        });
        worker.addEventListener('error', (event) => {
          phase('worker-error', { message: event.message });
          resolve({ result: null, error: event.message });
        });
        phase('worker-posting-request');
        worker.postMessage(
          options.task === 'transcription'
            ? {
                kind: 'transcribe',
                modelId: options.modelId,
                backend: options.backend,
                mode: options.mode,
                language: options.language,
                audio: payload,
              }
            : {
                kind: 'separate',
                modelId: options.modelId,
                backend: options.backend,
                mode: options.mode,
                audio: payload,
                maxSegments: options.maxSegments,
              },
          payload.channels.map((channel) => channel.buffer),
        );
      });

      const mainThread = stopHeartbeat();
      const memoryAfter = await fullSample();
      worker.terminate();

      const built: SpikeReport = {
        schema: 'kara-spike/1',
        startedAt,
        environment: {
          userAgent: navigator.userAgent,
          cores: navigator.hardwareConcurrency,
          crossOriginIsolated,
          webgpu: await describeWebGpu(),
        },
        input: {
          name: input.name,
          seconds: (input.channels[0]?.length ?? 0) / input.sampleRate,
          sampleRate: input.sampleRate,
          channels: input.channels.length,
          synthetic: input.synthetic,
        },
        run: outcome.result,
        mainThread,
        memoryBefore,
        memoryAfter,
        outcome: outcome.result === null ? 'failed' : 'completed',
        error: outcome.error,
      };

      setReport(built);
      setError(outcome.error);
      setBusy(false);
      return built;
    },
    [],
  );

  // Programmatic entry point for the Playwright run. The page drives itself
  // the same way, so there is one code path, not two.
  useEffect(() => {
    const api = {
      async runFromUrl(url: string, options: RunOptions): Promise<SpikeReport> {
        phase('fixture-fetch-start', { url });
        const response = await fetch(url);
        const bytes = await response.arrayBuffer();
        phase('fixture-fetched', { bytes: bytes.byteLength, status: response.status });
        const name = url.slice(url.lastIndexOf('/') + 1);
        const input = await decode(bytes, name, true);
        setLoaded(input);
        return run(options, input);
      },
      models: SEPARATION_MODELS.map((model) => model.id),
      transcriptionModels: TRANSCRIPTION_MODELS.map((model) => model.id),
      languages: [...SPIKE_LANGUAGES],
    };
    (globalThis as unknown as Record<string, unknown>)['karaSpike'] = api;
    phase('page-ready', { crossOriginIsolated });
  }, [decode, run]);

  const play = useCallback(async (stemFile: string) => {
    audioContext.current ??= new AudioContext();
    const context = audioContext.current;
    await context.resume();
    const interleaved = await readStem(stemFile);
    const frames = Math.floor(interleaved.length / 2);
    const buffer = context.createBuffer(2, frames, 44100);
    for (let channel = 0; channel < 2; channel += 1) {
      const target = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i += 1) {
        target[i] = interleaved[i * 2 + channel] ?? 0;
      }
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  }, []);

  const download = useCallback(() => {
    if (report === null) {
      return;
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `spike-${report.run?.modelId ?? 'run'}-${report.run?.backend ?? 'x'}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }, [report]);

  const model = useMemo(
    () => SEPARATION_MODELS.find((candidate) => candidate.id === modelId),
    [modelId],
  );

  return (
    <main className="spike">
      <h1>Kara M1 spike</h1>
      <p className="warn">
        Development page. Not part of the production build. Your file is decoded and processed in
        this tab and never uploaded.
      </p>

      <section>
        <h2>Environment</h2>
        <dl>
          <dt>Cross-origin isolated</dt>
          <dd>{crossOriginIsolated ? 'yes' : 'no'}</dd>
          <dt>WebGPU adapter</dt>
          <dd>{webgpu ?? 'unavailable'}</dd>
          <dt>Cores</dt>
          <dd>{navigator.hardwareConcurrency}</dd>
        </dl>
      </section>

      <section>
        <h2>Input</h2>
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) {
              return;
            }
            void file
              .arrayBuffer()
              .then((bytes) => decode(bytes, file.name, false))
              .then(setLoaded)
              .catch((cause: unknown) => setError(String(cause)));
          }}
        />
        {loaded !== null && (
          <p>
            {loaded.name}: {(loaded.channels[0]?.length ?? 0) / loaded.sampleRate} s,{' '}
            {loaded.sampleRate} Hz, {loaded.channels.length} ch
            {loaded.synthetic ? ' (synthesised fixture)' : ''}
          </p>
        )}
      </section>

      <section>
        <h2>Run</h2>
        <label>
          Task{' '}
          <select
            value={task}
            onChange={(event) => {
              const next = event.target.value as 'separation' | 'transcription';
              setTask(next);
              setModelId(
                (next === 'transcription' ? TRANSCRIPTION_MODELS[0]?.id : SEPARATION_MODELS[0]?.id) ?? '',
              );
            }}
          >
            <option value="separation">separation</option>
            <option value="transcription">transcription</option>
          </select>
        </label>
        <label>
          Model{' '}
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            {(task === 'transcription' ? TRANSCRIPTION_MODELS : SEPARATION_MODELS).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        {task === 'transcription' && (
          <label>
            Language{' '}
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              {SPIKE_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Backend{' '}
          <select value={backend} onChange={(event) => setBackend(event.target.value as Backend)}>
            <option value="webgpu">webgpu</option>
            <option value="wasm">wasm</option>
          </select>
        </label>
        <label>
          Mode{' '}
          <select value={mode} onChange={(event) => setMode(event.target.value as RunMode)}>
            <option value="audio">audio (writes stems)</option>
            <option value="bench">bench (inference only)</option>
            <option value="load">load (session creation only)</option>
          </select>
        </label>
        <label>
          Segment cap{' '}
          <input
            type="number"
            min="1"
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
              {
                task,
                modelId,
                backend,
                mode,
                maxSegments: Number.isFinite(cap) && cap > 0 ? cap : null,
                language,
              },
              loaded,
            );
          }}
        >
          {busy ? 'running' : 'run'}
        </button>
        {model !== undefined && !model.audioImplemented && mode === 'audio' && (
          <p className="warn">
            {model.id} has no host pipeline in this spike, so it always runs as a benchmark and
            produces no audio.
          </p>
        )}
      </section>

      {progress !== null && (
        <section>
          <h2>Progress</h2>
          <p>
            {progress.stage}: {progress.done}/{progress.total}
            {progress.etaMs !== null ? `, about ${formatSeconds(progress.etaMs)} left` : ''}
          </p>
          <p>JS heap now: {formatBytes(progress.memory.jsHeapBytes)}</p>
        </section>
      )}

      {error !== null && (
        <section>
          <h2>Failed</h2>
          <pre>{error}</pre>
        </section>
      )}

      {report !== null && report.run !== null && (
        <section>
          <h2>Result</h2>
          <dl>
            <dt>Model and backend</dt>
            <dd>
              {report.run.modelId} on {report.run.backend} ({report.run.mode})
            </dd>
            <dt>Model load</dt>
            <dd>{formatSeconds(report.run.loadMs)}</dd>
            <dt>Segments</dt>
            <dd>
              {report.run.segments}, median {Math.round(medianOf(report.run.segmentMs))} ms each
            </dd>
            <dt>Audio covered</dt>
            <dd>{report.run.audioSeconds.toFixed(1)} s</dd>
            <dt>Realtime factor</dt>
            <dd>{report.run.realtimeFactor.toFixed(2)}x</dd>
            <dt>Peak JS heap in worker</dt>
            <dd>{formatBytes(report.run.peakJsHeapBytes)}</dd>
            <dt>Agent memory before and after</dt>
            <dd>
              {formatBytes(report.memoryBefore?.agentBytes ?? null)} to{' '}
              {formatBytes(report.memoryAfter?.agentBytes ?? null)}
            </dd>
            <dt>Main thread</dt>
            <dd>
              {report.mainThread?.frames ?? 0} frames, worst gap{' '}
              {Math.round(report.mainThread?.maxGapMs ?? 0)} ms, {report.mainThread?.longFrames ?? 0}{' '}
              over 50 ms
            </dd>
          </dl>
          {report.run.stems.length > 0 && (
            <p>
              {report.run.stems.map((stem) => (
                <button
                  key={stem.name}
                  type="button"
                  onClick={() => {
                    void play(stem.opfsPath.slice(stem.opfsPath.lastIndexOf('/') + 1));
                  }}
                >
                  play {stem.name} ({formatBytes(stem.bytes)})
                </button>
              ))}
            </p>
          )}
          <ul>
            {report.run.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
          <button type="button" onClick={download}>
            export JSON
          </button>
        </section>
      )}

      <section>
        <h2>Hosting arithmetic</h2>
        <p>
          Cloudflare Pages refuses any asset over {formatBytes(PAGES_FILE_LIMIT_BYTES)}.
        </p>
        <ul>
          {SEPARATION_MODELS.map((candidate) => (
            <li key={candidate.id}>
              {candidate.id}: {formatBytes(candidate.totalBytes)} over {candidate.fileCount} file(s),
              largest {formatBytes(candidate.largestFileBytes)} &rarr;{' '}
              {candidate.largestFileBytes <= PAGES_FILE_LIMIT_BYTES
                ? 'fits on Pages'
                : 'too big for Pages'}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
