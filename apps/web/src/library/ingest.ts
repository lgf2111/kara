import type { JobSource } from '../separation/job.ts';
import type {
  ProgressMessage,
  SeparationMessage,
  SeparationResult,
  StartMessage,
} from '../separation/protocol.ts';

/**
 * Taking a picked file through decode and separation. Both steps happen in
 * this tab: nothing here touches the network.
 */

/** Overlap between model segments. Changing it invalidates every saved job. */
const OVERLAP = 0.25;

export interface Decoded {
  readonly source: JobSource;
  /** One channel each. Starting a run transfers these to the worker. */
  readonly channels: Float32Array<ArrayBuffer>[];
}

/**
 * Decodes with an OfflineAudioContext, which needs no output device and
 * resamples to the rate the model expects. Chrome accepts more containers
 * than it can decode, so a failure here is reported as the browser's, not the
 * file's.
 */
export async function decodeFile(file: File): Promise<Decoded> {
  const bytes = await file.arrayBuffer();
  // decodeAudioData takes ownership of the buffer and detaches it, after which
  // byteLength reads 0. The job identity depends on that number, so take it
  // first.
  const byteLength = bytes.byteLength;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(bytes);
  } catch (cause) {
    throw new Error(
      `this browser could not decode the audio in ${file.name}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  const channels: Float32Array<ArrayBuffer>[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const copy = new Float32Array(buffer.length);
    copy.set(buffer.getChannelData(channel));
    channels.push(copy);
  }
  return {
    source: {
      name: file.name,
      bytes: byteLength,
      sampleRate: buffer.sampleRate,
      samples: buffer.length,
    },
    channels,
  };
}

export interface SeparationOutcome {
  readonly result: SeparationResult;
  /** Cancelled runs keep their progress: the same file resumes from here. */
  readonly cancelled: boolean;
}

export interface RunningSeparation {
  /** Settles when the worker stops, whether it finished or was cancelled. */
  readonly finished: Promise<SeparationOutcome>;
  cancel(): void;
}

/**
 * Hands the decoded audio to the separation worker and reports progress.
 *
 * WASM only: the WebGPU backend returns NaN for every value of this model's
 * chain, which M1 measured and the worker refuses to write.
 */
export function startSeparation(
  decoded: Decoded,
  onProgress: (progress: ProgressMessage) => void,
): RunningSeparation {
  const worker = new Worker(new URL('../separation/separate.worker.ts', import.meta.url), {
    type: 'module',
  });

  const finished = new Promise<SeparationOutcome>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<SeparationMessage>) => {
      const message = event.data;
      if (message.kind === 'progress') {
        onProgress(message);
        return;
      }
      if (message.kind === 'failed') {
        reject(new Error(`${message.stage}: ${message.error}`));
        return;
      }
      resolve({ result: message.result, cancelled: message.kind === 'cancelled' });
    });
    worker.addEventListener('error', (event) => {
      reject(new Error(event.message === '' ? 'the separation worker stopped' : event.message));
    });
  }).finally(() => {
    worker.terminate();
  });

  const start: StartMessage = {
    kind: 'start',
    backend: 'wasm',
    source: decoded.source,
    audio: { sampleRate: decoded.source.sampleRate, channels: decoded.channels },
    overlap: OVERLAP,
    maxSegments: null,
    stems: 'pair',
  };
  // Transferred, not copied: a four-minute song is about 170 MB of float32 and
  // this machine cannot hold two of them. The caller's copy is detached.
  worker.postMessage(
    start,
    decoded.channels.map((channel) => channel.buffer),
  );

  return {
    finished,
    cancel() {
      worker.postMessage({ kind: 'cancel' });
    },
  };
}
