import { gainAt, heldGain, rampTo, type GainRamp } from '../audio/mix-gain.ts';
import { createPlayRing, type PlayRing } from '../audio/play-ring.ts';
import {
  BLOCK_CHANNELS,
  INSTRUMENTAL_LEFT,
  INSTRUMENTAL_RIGHT,
  PLAYBACK_PROCESSOR,
  PLAYBACK_REPORT_QUANTA,
  QUANTUM,
  VOCALS_LEFT,
  VOCALS_RIGHT,
  type PlaybackCommand,
  type PlaybackReport,
} from '../audio/worklet-messages.ts';

/** Seconds the ring holds, when nothing says otherwise. */
const DEFAULT_RING_SECONDS = 12;

interface RingOptions {
  readonly ringSeconds?: number;
}

/**
 * The only audible thing this extension makes.
 *
 * Capture mutes the tab, so whatever comes out of here is what the person
 * hears. It plays separated audio at the moment the delay says and nothing at
 * all before then, and it is the one place that can say honestly whether the
 * separation kept up: the ring counts every frame it was asked for and could
 * not supply.
 *
 * Where to read is arithmetic rather than a queue position. Each timeline has
 * an epoch — the context time at which its sample zero is due — so the frame
 * owed at this render quantum is `(currentTime - epoch) * sampleRate`, which
 * drifts from the ring's contents by nothing at all, because both are counted
 * in the same frames by the same clock. Before the epoch it plays silence,
 * which is what priming sounds like.
 *
 * What it plays is `instrumental + gain * vocals`. Gain 1 adds the stems back
 * into the audio the tab played, so `original` costs no extra buffer, and the
 * mode switch is a thirty millisecond ramp on that one number.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly ring: PlayRing;
  private scratch: Float32Array[];
  /** Context time sample zero of this timeline is due, or null while priming. */
  private epoch: number | null = null;
  private gain: GainRamp = heldGain(0);
  private quanta = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const asked = (options.processorOptions as RingOptions | undefined)?.ringSeconds;
    const seconds = typeof asked === 'number' && asked > 0 ? asked : DEFAULT_RING_SECONDS;
    this.ring = createPlayRing(BLOCK_CHANNELS, Math.round(seconds * sampleRate));
    this.scratch = Array.from({ length: BLOCK_CHANNELS }, () => new Float32Array(QUANTUM));
    this.port.onmessage = (event: MessageEvent<PlaybackCommand>): void => {
      this.accept(event.data);
    };
  }

  private accept(command: PlaybackCommand): void {
    switch (command.type) {
      case 'epoch':
        this.epoch = command.epoch;
        return;
      case 'block':
        this.ring.write(command.startFrame, command.channels);
        return;
      case 'gain':
        this.gain = rampTo(this.gain, command.target, currentTime, command.seconds);
        return;
      case 'flush':
        this.epoch = null;
        this.ring.reset();
        return;
    }
  }

  /** Scratch for a quantum, in case a context ever renders a bigger one. */
  private room(frames: number): Float32Array[] {
    if ((this.scratch[0]?.length ?? 0) < frames) {
      this.scratch = Array.from({ length: BLOCK_CHANNELS }, () => new Float32Array(frames));
    }
    return this.scratch;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0] ?? [];
    const left = out[0];
    if (left === undefined) {
      return true;
    }
    const right = out[1];
    const frames = left.length;
    left.fill(0);
    right?.fill(0);

    const epoch = this.epoch;
    const frame = epoch === null ? -1 : Math.round((currentTime - epoch) * sampleRate);
    if (frame >= 0) {
      const scratch = this.room(frames);
      this.ring.read(frame, frames, scratch);
      const vocalsLeft = scratch[VOCALS_LEFT];
      const vocalsRight = scratch[VOCALS_RIGHT];
      const otherLeft = scratch[INSTRUMENTAL_LEFT];
      const otherRight = scratch[INSTRUMENTAL_RIGHT];
      if (
        vocalsLeft !== undefined &&
        vocalsRight !== undefined &&
        otherLeft !== undefined &&
        otherRight !== undefined
      ) {
        for (let index = 0; index < frames; index += 1) {
          const gain = gainAt(this.gain, currentTime + index / sampleRate);
          left[index] = (otherLeft[index] ?? 0) + gain * (vocalsLeft[index] ?? 0);
          if (right !== undefined) {
            right[index] = (otherRight[index] ?? 0) + gain * (vocalsRight[index] ?? 0);
          }
        }
      }
    }

    this.quanta += 1;
    if (this.quanta >= PLAYBACK_REPORT_QUANTA) {
      this.quanta = 0;
      this.report();
    }
    return true;
  }

  private report(): void {
    const report: PlaybackReport = {
      type: 'playback',
      readTo: this.ring.readTo,
      underrunFrames: this.ring.underrunFrames,
      lateFrames: this.ring.lateFrames,
      aheadFrames: this.ring.aheadFrames,
      gapFrames: this.ring.gapFrames,
      queuedFrames: this.ring.queuedFrames,
    };
    this.port.postMessage(report);
  }
}

registerProcessor(PLAYBACK_PROCESSOR, PlaybackProcessor);
