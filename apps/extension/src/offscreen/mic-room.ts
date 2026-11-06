import { createMicGraph, type MicGraph } from '../audio/mic-graph.ts';
import {
  IDLE_MIC_STATUS,
  normaliseMicFx,
  withMicFx,
  type MicFx,
  type MicStatus,
} from '../audio/mic-fx.ts';
import {
  MIC_CONSTRAINTS,
  microphoneErrorText,
  stopMicrophone,
} from '../audio/microphone.ts';
import {
  IDLE_RECORDING,
  nextRecording,
  recordingFileName,
  type RecordingStatus,
} from '../audio/recording.ts';

/**
 * The microphone, its effects and its recorder, in one place.
 *
 * The engine owns its `AudioContext`, so the microphone has to live in that
 * context to reach the same recording bus as the stems. This class owns the
 * stream and the graph and hands the stream to pitch practice when practice
 * asks for it: `acquire` and `release` are reference-counted by use, so an
 * open microphone is never opened twice and is only closed when the last
 * caller — monitor, recorder or practice — has let go.
 *
 * Monitoring and recording are deliberately independent. Monitor is one gain
 * into the speakers and starts shut; the recording bus is fed whether it is
 * open or not. MediaRecorder writes WebM/Opus, and the finished blob is handed
 * to the service worker as an object URL because only that context may call
 * `chrome.downloads`.
 */

/** What is holding the microphone open. */
export type MicUse = 'monitor' | 'record' | 'practice';

export interface MicRoomOptions {
  readonly context: AudioContext;
  /** The video the recording belongs to, for its filename. */
  readonly videoId: string | null;
  readonly nowMs: () => number;
  readonly openStream: (constraints: MediaTrackConstraints) => Promise<MediaStream>;
  /** Something the panel draws has changed. */
  readonly onStatus: () => void;
  /** Ask the service worker to save the finished object URL. */
  readonly onDownload: (url: string, filename: string) => void;
}

/** How often the recording timer advances, and the panel's clock with it. */
const TIMER_MS = 500;

/** How long to wait for MediaRecorder's final `dataavailable` before giving up. */
const FLUSH_MS = 2000;

/** How long the object URL stays alive for the download to pick it up. */
const URL_MS = 60_000;

function recordingMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  for (const candidate of ['audio/webm;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

function describeRecorderError(cause: unknown): string {
  return `The recording stopped: ${cause instanceof Error && cause.message !== '' ? cause.message : 'the recorder failed'}`;
}

export class MicRoom {
  private readonly context: AudioContext;
  private readonly videoId: string | null;
  private readonly nowMs: () => number;
  private readonly openStream: MicRoomOptions['openStream'];
  private readonly onStatus: () => void;
  private readonly onDownload: MicRoomOptions['onDownload'];
  /** Everything the stems and the microphone are recorded through. */
  readonly recordInput: GainNode;
  private readonly recordDestination: MediaStreamAudioDestinationNode;
  private readonly uses = new Set<MicUse>();
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private graph: MicGraph | null = null;
  private opening: Promise<void> | null = null;
  private fx: MicFx = IDLE_MIC_STATUS.fx;
  private error: string | null = null;
  private recording: RecordingStatus = IDLE_RECORDING;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private settle: (() => void) | null = null;
  /** The current flush, so a second stop can wait for the first rather than skip it. */
  private flush: Promise<void> | null = null;
  private pendingError: string | null = null;
  private disposed = false;

  constructor(options: MicRoomOptions) {
    this.context = options.context;
    this.videoId = options.videoId;
    this.nowMs = options.nowMs;
    this.openStream = options.openStream;
    this.onStatus = options.onStatus;
    this.onDownload = options.onDownload;
    this.recordInput = this.context.createGain();
    this.recordDestination = this.context.createMediaStreamDestination();
    this.recordInput.connect(this.recordDestination);
  }

  status(): MicStatus {
    const enabled = this.stream !== null && this.graph !== null;
    return {
      fx: this.fx,
      enabled,
      monitor: enabled && this.fx.monitor,
      error: this.error,
      recording: this.recording,
    };
  }

  /** Open the microphone for one use and share it with every other. */
  async acquire(use: MicUse): Promise<{ readonly stream: MediaStream; readonly context: AudioContext }> {
    this.uses.add(use);
    try {
      await this.ensureOpen();
    } catch (cause) {
      this.uses.delete(use);
      throw cause;
    }
    if (this.stream === null) {
      this.uses.delete(use);
      throw new Error('the microphone closed while it was being opened');
    }
    return { stream: this.stream, context: this.context };
  }

  /** Let go of one use; the last one out closes the stream. */
  release(use: MicUse): void {
    this.uses.delete(use);
    if (this.uses.size === 0) {
      this.closeMicrophone();
    }
  }

  /** The whole desk from the panel, monitor switch included. */
  setFx(raw: unknown): void {
    const next = normaliseMicFx(raw);
    const wasMonitoring = this.fx.monitor;
    this.fx = next;
    this.applyFx();
    if (next.monitor && !wasMonitoring) {
      void this.acquire('monitor').catch((cause: unknown) => {
        this.noteMicrophoneError(cause);
      });
    } else if (!next.monitor && wasMonitoring) {
      this.release('monitor');
    }
    this.onStatus();
  }

  /** Start a take, opening the microphone if recording is the first use. */
  async beginRecording(): Promise<void> {
    if (this.recording.state === 'recording' || this.recording.state === 'saving') {
      return;
    }
    const atMs = this.nowMs();
    const filename = recordingFileName(this.videoId, atMs);
    try {
      await this.acquire('record');
    } catch (cause) {
      this.recording = nextRecording(this.recording, {
        type: 'failed',
        atMs,
        detail: microphoneErrorText(cause, 'practice'),
      });
      this.noteMicrophoneError(cause);
      return;
    }
    if (this.disposed) {
      this.release('record');
      return;
    }
    const mime = recordingMime();
    if (mime === null) {
      this.recording = nextRecording(this.recording, {
        type: 'failed',
        atMs,
        detail: 'This browser cannot record WebM audio.',
      });
      this.release('record');
      this.onStatus();
      return;
    }
    try {
      const recorder = new MediaRecorder(this.recordDestination.stream, { mimeType: mime });
      this.chunks = [];
      this.pendingError = null;
      this.recorder = recorder;
      recorder.ondataavailable = (event: BlobEvent): void => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };
      recorder.onerror = (event: Event): void => {
        const cause = (event as Event & { readonly error?: unknown }).error;
        this.pendingError = describeRecorderError(cause);
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            this.finishRecording();
          }
        } else {
          this.finishRecording();
        }
      };
      recorder.onstop = (): void => {
        this.finishRecording();
      };
      this.error = null;
      this.recording = nextRecording(this.recording, { type: 'start', atMs, filename });
      recorder.start(1000);
      this.startTimer();
    } catch (cause) {
      this.recording = nextRecording(this.recording, {
        type: 'failed',
        atMs,
        detail: `The recorder could not start: ${cause instanceof Error && cause.message !== '' ? cause.message : 'unknown error'}`,
      });
      this.release('record');
    }
    this.onStatus();
  }

  /** Stop and flush the take, waiting for the final chunk before returning. */
  async stopRecording(): Promise<void> {
    // A stop already in flight is not a reason to return before it lands: the
    // session may be ending, and the file has not been handed over yet.
    if (this.recording.state === 'saving') {
      if (this.flush !== null) {
        await Promise.race([
          this.flush,
          new Promise<void>((resolve) => {
            setTimeout(resolve, FLUSH_MS);
          }),
        ]);
      }
      return;
    }
    const recorder = this.recorder;
    if (recorder === null || this.recording.state !== 'recording') {
      return;
    }
    this.recording = nextRecording(this.recording, { type: 'stop', atMs: this.nowMs() });
    this.clearTimer();
    this.onStatus();
    const flushed = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    this.flush = flushed;
    try {
      recorder.requestData();
      recorder.stop();
    } catch (cause) {
      this.pendingError = describeRecorderError(cause);
      this.finishRecording();
    }
    await Promise.race([
      flushed,
      new Promise<void>((resolve) => {
        setTimeout(resolve, FLUSH_MS);
      }),
    ]);
    // A recorder that never delivered its stop event must not leave the panel
    // saying "Saving" forever, or the microphone held for a take that ended.
    if (this.recorder !== null) {
      this.pendingError = 'The recording could not be finished.';
      this.finishRecording();
    }
  }

  /** Stop everything and release the device. Used when the session ends. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.stopRecording();
    this.disposed = true;
    this.clearTimer();
    this.uses.clear();
    this.closeMicrophone();
    this.recordInput.disconnect();
    this.recordDestination.disconnect();
  }

  private async ensureOpen(): Promise<void> {
    if (this.stream !== null) {
      return;
    }
    if (this.opening === null) {
      this.opening = this.open().finally(() => {
        this.opening = null;
      });
    }
    await this.opening;
  }

  private async open(): Promise<void> {
    const stream = await this.openStream(MIC_CONSTRAINTS);
    if (this.disposed) {
      stopMicrophone(stream);
      throw new Error('the microphone was released');
    }
    let graph: MicGraph | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      source = this.context.createMediaStreamSource(stream);
      graph = createMicGraph(this.context, this.context.destination, this.recordInput);
      source.connect(graph.input);
      this.stream = stream;
      this.source = source;
      this.graph = graph;
      this.error = null;
      this.applyFx();
      this.onStatus();
    } catch (cause) {
      source?.disconnect();
      graph?.disconnect();
      stopMicrophone(stream);
      throw cause;
    }
  }

  private closeMicrophone(): void {
    this.source?.disconnect();
    this.source = null;
    this.graph?.disconnect();
    this.graph = null;
    if (this.stream !== null) {
      stopMicrophone(this.stream);
      this.stream = null;
    }
    this.onStatus();
  }

  private applyFx(): void {
    this.graph?.apply(this.fx, this.context.currentTime);
  }

  private noteMicrophoneError(cause: unknown): void {
    this.error = microphoneErrorText(cause, 'practice');
    this.fx = withMicFx(this.fx, { monitor: false });
    this.uses.delete('monitor');
    this.onStatus();
  }

  private startTimer(): void {
    this.clearTimer();
    this.timer = setInterval(() => {
      this.recording = nextRecording(this.recording, { type: 'tick', atMs: this.nowMs() });
      this.onStatus();
    }, TIMER_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private finishRecording(): void {
    const recorder = this.recorder;
    if (recorder === null) {
      return;
    }
    this.recorder = null;
    this.clearTimer();
    const status = this.recording;
    const filename = status.filename ?? recordingFileName(this.videoId, this.nowMs());
    const failure = this.pendingError;
    this.pendingError = null;
    const chunks = this.chunks;
    this.chunks = [];
    const settled = this.settle;
    this.settle = null;
    this.flush = null;

    let downloaded = false;
    if (chunks.length > 0) {
      const type = recorder.mimeType === '' ? 'audio/webm' : recorder.mimeType;
      const blob = new Blob(chunks, { type });
      if (blob.size > 0) {
        const url = URL.createObjectURL(blob);
        this.onDownload(url, filename);
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, URL_MS);
        downloaded = true;
      }
    }

    if (failure !== null) {
      this.recording = nextRecording(this.recording, {
        type: 'failed',
        atMs: this.nowMs(),
        detail: downloaded ? `${failure} The part recorded was saved.` : failure,
      });
    } else if (downloaded) {
      this.recording = nextRecording(this.recording, { type: 'saved' });
    } else {
      this.recording = nextRecording(this.recording, {
        type: 'failed',
        atMs: this.nowMs(),
        detail: 'The recording was empty.',
      });
    }
    this.release('record');
    settled?.();
    this.onStatus();
  }
}
