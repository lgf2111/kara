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
 * What it plays is `(instrumental + gain * vocals) * master`. Gain 1 adds the
 * stems back into the audio the tab played, so `original` costs no extra
 * buffer, and the mode switch is a thirty millisecond ramp on that one number.
 *
 * **The hold is why the epoch is a variable rather than a constant.** A page
 * that pauses has not seeked: the audio either side of the pause is the same
 * song with nothing missing between it, and throwing the buffer away would
 * cost the whole delay again for a click on the video. So a hold fades the
 * output out, stops reading — which is also what stops the ring counting
 * frames late, missing or early for a stretch nobody was listening to — and a
 * resume pushes the epoch forward by exactly how long that lasted. Every
 * sample after the pause then plays at the same place in the delay it would
 * have, and the same number is reported back so the picture can be shifted by
 * it too.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly ring: PlayRing;
  private scratch: Float32Array[];
  /** Context time sample zero of this timeline is due, or null while priming. */
  private epoch: number | null = null;
  private gain: GainRamp = heldGain(0);
  /** Everything leaves through this: the mute, the fade in, the crossfade. */
  private master: GainRamp = heldGain(1);
  /** Context time the output stops moving at, or null when it is moving. */
  private holdAt: number | null = null;
  private heldSeconds = 0;
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
      case 'master':
        this.master = rampTo(
          this.master,
          command.target,
          command.at ?? currentTime,
          command.seconds,
          command.shape,
        );
        return;
      case 'hold':
        if (this.holdAt === null) {
          // Faded out first and frozen when the fade lands, so that the hold
          // is silent rather than abrupt and the twenty milliseconds it costs
          // are counted as played.
          this.holdAt = currentTime + Math.max(0, command.seconds);
          this.master = rampTo(this.master, 0, currentTime, command.seconds, 'smooth');
        }
        return;
      case 'resume':
        if (this.holdAt !== null) {
          const held = Math.max(0, currentTime - this.holdAt);
          this.heldSeconds += held;
          if (this.epoch !== null) {
            this.epoch += held;
          }
          this.holdAt = null;
          this.master = rampTo(this.master, 1, currentTime, command.seconds, 'smooth');
        }
        return;
      case 'flush':
        this.epoch = null;
        this.holdAt = null;
        this.heldSeconds = 0;
        this.master = heldGain(1);
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
    // Frozen: silence, and nothing read, so the ring counts nothing against a
    // stretch the person was not listening to.
    const frozen = this.holdAt !== null && currentTime >= this.holdAt;
    const frame = epoch === null || frozen ? -1 : Math.round((currentTime - epoch) * sampleRate);
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
          const at = currentTime + index / sampleRate;
          const gain = gainAt(this.gain, at);
          const master = gainAt(this.master, at);
          left[index] = master * ((otherLeft[index] ?? 0) + gain * (vocalsLeft[index] ?? 0));
          if (right !== undefined) {
            right[index] = master * ((otherRight[index] ?? 0) + gain * (vocalsRight[index] ?? 0));
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
      // Mid-hold, what has been held so far, so the picture can follow
      // without waiting for the resume.
      heldSeconds:
        this.heldSeconds +
        (this.holdAt === null ? 0 : Math.max(0, currentTime - this.holdAt)),
    };
    this.port.postMessage(report);
  }
}

registerProcessor(PLAYBACK_PROCESSOR, PlaybackProcessor);
