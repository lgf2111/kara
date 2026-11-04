import { createPitchShifter, type PitchShifter } from '../../../web/src/dsp/pitch-shift.ts';
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

/** What leaves: a stereo pair, whatever the ring holds. */
const OUT_CHANNELS = 2;

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
 * owed at this render quantum is `(heard - epoch) * sampleRate`, which drifts
 * from the ring's contents by nothing at all, because both are counted in the
 * same frames by the same clock. Before the epoch it plays silence, which is
 * what priming sounds like.
 *
 * What it plays is `pitch((instrumental + gain * vocals) * master)`. Gain 1
 * adds the stems back into the audio the tab played, so `original` costs no
 * extra buffer, and the mode switch is a thirty millisecond ramp on that one
 * number.
 *
 * **The key is last, after the mixing and before the output**, so it applies
 * to the instrumental, the guide vocal and the original alike rather than to
 * one stem. It is `apps/web/src/dsp/pitch-shift.ts`, which is a phase vocoder
 * whose reported latency is the same at no shift as at any shift; at no shift
 * it is bypassed but still delayed by exactly that, so pressing a key button
 * cannot move the audio against the delayed picture.
 *
 * **Which means there are two clocks in here and one of them is the only one
 * that matters.** `currentTime` is when a sample is *computed*; it is heard
 * `shiftSeconds` later, because that is how long the shifter holds it. Every
 * moment this file reasons about — the epoch, the gain ramps, the instant a
 * hold freezes — is a moment on the audible timeline, which is where the
 * capture clock and the picture both live. `heard` is the one bridge between
 * them, and it is the whole of the sync arithmetic: read `shiftSeconds` early,
 * and the sample comes out on time.
 *
 * **A growing delay is the other reason the epoch moves.** When one window
 * starts costing more than it did at the start of the song, the read head
 * eventually passes the frontier of finalised audio — and from then on every
 * arriving block is for a frame already read, which the ring refuses, so the
 * output plays nothing for the rest of the song. So the delay grows: `shift`
 * fades out, moves the epoch forward by the shortfall, rewinds the ring's read
 * mark to meet it, and fades back in on the audio it had been starving for.
 * The picture follows by itself, because what it follows is where in the song
 * this output says it is.
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
  /** The mixed pair, which the shifter works on in place. */
  private voice: Float32Array[];
  private readonly shifter: PitchShifter;
  /** Seconds between a sample being computed here and being audible. */
  private readonly shiftSeconds: number;
  /** Context time sample zero of this timeline is due, or null while priming. */
  private epoch: number | null = null;
  private gain: GainRamp = heldGain(0);
  /** Everything leaves through this: the mute, the fade in, the crossfade. */
  private master: GainRamp = heldGain(1);
  /** Audible time the output stops moving at, or null when it is moving. */
  private holdAt: number | null = null;
  private heldSeconds = 0;
  private quanta = 0;
  /** Audible time a pending delay growth lands at, or null when there is none. */
  private shiftAt: number | null = null;
  private shiftBy = 0;
  private shiftFade = 0;
  /** The frame being read now, for the report. -1 while nothing is read. */
  private playFrame = -1;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const asked = (options.processorOptions as RingOptions | undefined)?.ringSeconds;
    const seconds = typeof asked === 'number' && asked > 0 ? asked : DEFAULT_RING_SECONDS;
    this.ring = createPlayRing(BLOCK_CHANNELS, Math.round(seconds * sampleRate));
    this.scratch = Array.from({ length: BLOCK_CHANNELS }, () => new Float32Array(QUANTUM));
    this.voice = Array.from({ length: OUT_CHANNELS }, () => new Float32Array(QUANTUM));
    this.shifter = createPitchShifter({ channels: OUT_CHANNELS, sampleRate });
    this.shiftSeconds = this.shifter.latencySamples / sampleRate;
    this.port.onmessage = (event: MessageEvent<PlaybackCommand>): void => {
      this.accept(event.data);
    };
  }

  /**
   * The moment the sample being computed now will actually be heard.
   *
   * Everything on the audible timeline is reached `shiftSeconds` earlier here
   * than on the clock, because the shifter holds each sample for that long.
   */
  private get heard(): number {
    return currentTime + this.shiftSeconds;
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
        this.gain = rampTo(this.gain, command.target, this.heard, command.seconds);
        return;
      case 'master':
        this.master = rampTo(
          this.master,
          command.target,
          command.at ?? this.heard,
          command.seconds,
          command.shape,
        );
        return;
      case 'transpose':
        this.shifter.setSemitones(command.semitones);
        return;
      case 'hold':
        if (this.holdAt === null) {
          // Faded out first and frozen when the fade lands, so that the hold
          // is silent rather than abrupt and the twenty milliseconds it costs
          // are counted as played.
          const from = this.heard;
          this.holdAt = from + Math.max(0, command.seconds);
          this.master = rampTo(this.master, 0, from, command.seconds, 'smooth');
        }
        return;
      case 'resume':
        if (this.holdAt !== null) {
          const from = this.heard;
          const held = Math.max(0, from - this.holdAt);
          this.heldSeconds += held;
          if (this.epoch !== null) {
            this.epoch += held;
          }
          this.holdAt = null;
          this.master = rampTo(this.master, 1, from, command.seconds, 'smooth');
        }
        return;
      case 'shift':
        if (this.shiftAt === null && this.epoch !== null && command.seconds > 0) {
          // Faded out first and stepped when the fade lands, for the same
          // reason a pause is: a step in the read position lands in the middle
          // of a waveform, and a corner in a waveform is a click.
          const from = this.heard;
          this.shiftFade = Math.max(0, command.fadeSeconds);
          this.shiftAt = from + this.shiftFade;
          this.shiftBy = command.seconds;
          this.master = rampTo(this.master, 0, from, this.shiftFade, 'smooth');
        }
        return;
      case 'flush':
        this.epoch = null;
        this.holdAt = null;
        this.heldSeconds = 0;
        this.shiftAt = null;
        this.shiftBy = 0;
        this.playFrame = -1;
        this.master = heldGain(1);
        this.ring.reset();
        // The key is the person's choice and a new timeline is not them
        // changing their mind, so the shifter keeps it and drops its buffers.
        this.shifter.reset();
        return;
    }
  }

  /**
   * Applies a pending delay growth once its fade has landed: the epoch moves
   * forward, the read mark goes back to meet it, and the output fades in on
   * audio it had been starving for.
   */
  private land(heard: number): void {
    const at = this.shiftAt;
    // Never through a hold: the output is already silent and frozen, and a
    // fade in landing mid-pause would be audible with nobody listening for it.
    if (at === null || heard < at || this.epoch === null || this.holdAt !== null) {
      return;
    }
    this.epoch += this.shiftBy;
    this.shiftAt = null;
    this.shiftBy = 0;
    this.ring.rewind(Math.round((heard - this.epoch) * sampleRate));
    this.master = rampTo(this.master, 1, heard, this.shiftFade, 'smooth');
  }

  /** Scratch for a quantum, in case a context ever renders a bigger one. */
  private room(frames: number): Float32Array[] {
    if ((this.scratch[0]?.length ?? 0) < frames) {
      this.scratch = Array.from({ length: BLOCK_CHANNELS }, () => new Float32Array(frames));
      this.voice = Array.from({ length: OUT_CHANNELS }, () => new Float32Array(frames));
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
    const scratch = this.room(frames);
    const voiceLeft = this.voice[0];
    const voiceRight = this.voice[1];
    if (voiceLeft === undefined || voiceRight === undefined) {
      return true;
    }
    voiceLeft.fill(0, 0, frames);
    voiceRight.fill(0, 0, frames);

    const heard = this.heard;
    this.land(heard);
    const epoch = this.epoch;
    // Frozen: silence, and nothing read, so the ring counts nothing against a
    // stretch the person was not listening to.
    const frozen = this.holdAt !== null && heard >= this.holdAt;
    const frame = epoch === null || frozen ? -1 : Math.round((heard - epoch) * sampleRate);
    this.playFrame = frame;
    if (frame >= 0) {
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
          const at = heard + index / sampleRate;
          const gain = gainAt(this.gain, at);
          const master = gainAt(this.master, at);
          voiceLeft[index] = master * ((otherLeft[index] ?? 0) + gain * (vocalsLeft[index] ?? 0));
          voiceRight[index] =
            master * ((otherRight[index] ?? 0) + gain * (vocalsRight[index] ?? 0));
        }
      }
    }

    // Always, even through a freeze. The shifter's delay is what the whole
    // timeline above is corrected for, so it cannot be skipped when there is
    // nothing to play: the samples already inside it are the fade out.
    this.shifter.process(this.voice, this.voice, frames);
    for (let index = 0; index < frames; index += 1) {
      left[index] = voiceLeft[index] ?? 0;
    }
    if (right !== undefined) {
      for (let index = 0; index < frames; index += 1) {
        right[index] = voiceRight[index] ?? 0;
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
      playFrame: this.playFrame,
      underrunFrames: this.ring.underrunFrames,
      lateFrames: this.ring.lateFrames,
      aheadFrames: this.ring.aheadFrames,
      gapFrames: this.ring.gapFrames,
      queuedFrames: this.ring.queuedFrames,
      // Mid-hold, what has been held so far, so the picture can follow
      // without waiting for the resume.
      heldSeconds:
        this.heldSeconds + (this.holdAt === null ? 0 : Math.max(0, this.heard - this.holdAt)),
    };
    this.port.postMessage(report);
  }
}

registerProcessor(PLAYBACK_PROCESSOR, PlaybackProcessor);
