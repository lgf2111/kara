/// <reference lib="webworker" />
import { gainAt, heldGain, rampTo, type GainRamp } from '../audio/mix-gain.ts';
import { STEMS, stemLevel } from '../audio/stems.ts';
import {
  JUMP_FRAMES,
  PLAYBACK_REPORT_QUANTA,
  QUANTUM,
  STEM_CHANNELS,
  STEM_PLAYER_PROCESSOR,
  type StemPlayerCommand,
  type StemPlayerReport,
} from '../audio/stem-player-messages.ts';

/**
 * The only audible thing this extension makes, now a player rather than a
 * relay.
 *
 * The old worklet read a ring of separated blocks at the moment a delay said
 * they were due. This one holds the whole separated track — four stereo stems,
 * handed over once — and plays whatever frame the video is at. There is no
 * delay to be told about and no ring to run dry: the one number it needs is
 * where the video is, which arrives as an anchor about four times a second.
 *
 * **Four levels, one sum.** Each stem has a gain of its own, ramped rather
 * than stepped, and the output is their sum times the master. At one each the
 * sum is the mixture the video played, so no combination of sliders can clip
 * a track that did not already clip. The order is the model's, which is the
 * order `audio/stems.ts` names and the separator sends.
 *
 * **The anchor is the clock.** Each `anchor` message says "the video is at
 * media time M, and it is moving at rate R". The head becomes M (projected
 * by the sender to the instant of sending), and between anchors it advances
 * by R. The video's own clock is therefore the only clock that matters: the
 * audio clock drifts against it by parts per million, and four anchors a
 * second correct for that without anybody noticing.
 *
 * **A jump is faded, a drift is not.** A seek moves the head by minutes,
 * which cannot be stepped into: the output fades out over ten milliseconds,
 * the head lands, and it fades back in. A correction of a few frames is
 * stepped bare, because a few frames is a tenth of a millisecond and fading
 * over it would only make it louder.
 *
 * **Not playing means frozen, and silence.** A pause is not a reset. The
 * head holds where it is, the output mutes on a raised cosine, and a resume
 * carries on from the same frame: nothing is thrown away, nothing is primed.
 * An ad and a rate change ride the same flag, because they are the same
 * sentence from the page's point of view: the video's sound is not what the
 * stems should be playing.
 *
 * **The key is last, after the mixing and before the output**, so it applies
 * to the instrumental and the guide vocal alike. It is a Signalsmith Stretch
 * worklet after this player, whose reported latency is the same at no shift
 * as at any shift. That constant latency is paid in the anchor: the head is
 * read `shiftSeconds` early, so the sample the video is at leaves the shifter
 * exactly when the video shows it.
 */

/** How long a jump's fade is, in seconds. */
const JUMP_FADE_SECONDS = 0.01;

/** How long a pause's mute and unmute are, in seconds. */
const MUTE_SECONDS = 0.02;

/** What leaves: a stereo pair. */
const OUT_CHANNELS = 2;

class StemPlayerProcessor extends AudioWorkletProcessor {
  private stems: readonly Float32Array[] | null = null;
  private length = 0;
  /**
   * Frames from the start that have actually been separated. The track can be
   * longer than this while the rest is still being prepared; the head is not
   * allowed past the frontier, so nothing is played out of the zeros.
   */
  private readyFrames = 0;
  private head = 0;
  private rate = 1;
  private playing = true;
  /** One level per stem, in `STEMS` order; each is its own ramp. */
  private gains: GainRamp[] = STEMS.map(() => heldGain(0));
  /** The opt-in Voice 1 / Voice 2 pair, when the helper has finished. */
  private duet: readonly [Float32Array, Float32Array] | null = null;
  private duetGains: GainRamp[] = [heldGain(0), heldGain(0)];
  private duetActive = false;
  private master: GainRamp = heldGain(0);
  /**
   * Where the master is going, which is not the same question as where it is.
   *
   * A jump fades the master to nought and back to this; a pause does the same.
   * Reading the target back off the ramp would read the nought, which is how a
   * seek or a resume used to leave the player silent for the rest of the song.
   */
  private masterTarget = 0;
  /**
   * A pause keeps feeding the stems for one mute's worth before freezing, so
   * the fade has something to fade. Freezing the head at once would cut the
   * sound off after the pitch shifter's latency with the gain still at one.
   */
  private draining = false;
  private drainUntil = 0;
  /**
   * How long the pitch-shift node after this player holds a sample. The head
   * reads this far ahead so the shifted output arrives with the picture; the
   * node reports the number, and the engine passes it on.
   */
  private shiftSeconds = 0;
  /** A jump that is waiting for its fade to land. */
  private pendingJump: { readonly at: number; readonly to: number } | null = null;
  private voice: Float32Array[];
  private quanta = 0;
  private playFrame = -1;
  private stopped = false;

  constructor() {
    super();
    this.voice = Array.from({ length: OUT_CHANNELS }, () => new Float32Array(QUANTUM));
    this.port.onmessage = (event: MessageEvent<StemPlayerCommand>): void => {
      this.accept(event.data);
    };
  }

  /**
   * The moment the sample being computed now will actually be heard.
   *
   * The pitch shifter holds each sample for `shiftSeconds`, so everything this file
   * reasons about is on the audible timeline, and reading the stems at the
   * position the video is at now means reading them `shiftSeconds` early.
   */
  private get heard(): number {
    return currentTime + this.shiftSeconds;
  }

  /** The delay after this player, in whole samples. */
  private get shiftSamples(): number {
    return Math.round(this.shiftSeconds * sampleRate);
  }

  private accept(command: StemPlayerCommand): void {
    switch (command.type) {
      case 'stems': {
        const channels = command.channels;
        this.setStems(channels);
        this.readyFrames = this.length;
        return;
      }
      case 'begin': {
        const frames = Math.max(0, Math.floor(command.frames));
        this.setStems(
          Array.from({ length: STEM_CHANNELS }, () => new Float32Array(frames)),
        );
        this.readyFrames = 0;
        return;
      }
      case 'stem-block': {
        const stems = this.stems;
        if (stems === null || command.startSample !== this.readyFrames) {
          // Out of order is not something the separator produces. Dropping it
          // is safer than filling a hole the frontier would then jump over.
          return;
        }
        const frames = command.channels[0]?.length ?? 0;
        if (frames <= 0) {
          return;
        }
        for (let index = 0; index < stems.length; index += 1) {
          const channel = command.channels[index];
          const into = stems[index];
          if (channel === undefined || into === undefined) {
            continue;
          }
          const start = command.startSample;
          into.set(channel.subarray(0, Math.min(channel.length, into.length - start)), start);
        }
        this.readyFrames = Math.min(this.length, command.startSample + frames);
        // A block can arrive after the head reached the old frontier and the
        // master faded for it. If the video is still playing, fade back in;
        // the engine's next anchor will be at the same place.
        if (this.playing) {
          this.master = rampTo(this.master, this.masterTarget, this.heard, MUTE_SECONDS, 'smooth');
        }
        return;
      }
      case 'mix': {
        for (let index = 0; index < this.gains.length; index += 1) {
          const ramp = this.gains[index];
          if (ramp === undefined) {
            continue;
          }
          this.gains[index] = rampTo(
            ramp,
            stemLevel(command.gains[index]),
            this.heard,
            command.seconds,
          );
        }
        return;
      }
      case 'duet': {
        const wasActive = this.duetActive;
        this.duet = [command.voice1, command.voice2];
        this.duetActive = true;
        if (!wasActive) {
          this.duetGains = [heldGain(0), heldGain(0)];
        }
        return;
      }
      case 'duet-mix': {
        for (let index = 0; index < this.duetGains.length; index += 1) {
          const ramp = this.duetGains[index];
          if (ramp === undefined) {
            continue;
          }
          this.duetGains[index] = rampTo(
            ramp,
            stemLevel(command.gains[index]),
            this.heard,
            command.seconds,
          );
        }
        return;
      }
      case 'duet-swap': {
        if (this.duet !== null) {
          this.duet = [this.duet[1], this.duet[0]];
        }
        return;
      }
      case 'duet-clear': {
        this.duet = null;
        this.duetActive = false;
        this.duetGains = [heldGain(0), heldGain(0)];
        return;
      }
      case 'master':
        this.masterTarget = command.target;
        // A target while paused is for the resume, not for now.
        this.master = rampTo(
          this.master,
          this.playing ? command.target : 0,
          this.heard,
          command.seconds,
          command.shape,
        );
        return;
      case 'latency':
        this.shiftSeconds =
          Number.isFinite(command.samples) && command.samples > 0
            ? command.samples / sampleRate
            : 0;
        return;
      case 'anchor':
        if (this.stems === null || this.playing === false) {
          // A pause has the head frozen at its own number; an anchor arriving
          // during one is the video still talking, not a reason to move. The
          // next anchor after the resume lands where the video is.
          return;
        }
        this.land(command.mediaSeconds, command.rate);
        return;
      case 'playing':
        if (command.playing) {
          if (this.playing === false) {
            this.playing = true;
            this.draining = false;
            this.master = rampTo(
              this.master,
              this.masterTarget,
              this.heard,
              MUTE_SECONDS,
              'smooth',
            );
          }
        } else if (this.playing) {
          this.playing = false;
          this.pendingJump = null;
          if (this.stems !== null) {
            this.draining = true;
            this.drainUntil = this.heard + MUTE_SECONDS;
          }
          this.master = rampTo(this.master, 0, this.heard, MUTE_SECONDS, 'smooth');
        }
        return;
      case 'stop':
        this.stopped = true;
        this.playing = false;
        this.draining = false;
        return;
    }
  }

  /** Installs a fresh track and puts the player back at its beginning. */
  private setStems(channels: readonly Float32Array[]): void {
    this.stems = channels;
    this.length = channels[0]?.length ?? 0;
    this.head = 0;
    this.rate = 1;
    this.playing = false;
    this.draining = false;
    this.pendingJump = null;
    this.gains = STEMS.map(() => heldGain(0));
    this.master = heldGain(0);
    this.masterTarget = 0;
    this.duet = null;
    this.duetActive = false;
    this.duetGains = [heldGain(0), heldGain(0)];
  }

  /** The master target a resume goes back to, set by the last `master`. */
  private get wantedMaster(): number {
    return this.masterTarget;
  }

  /**
   * Puts the head where the video says it is.
   *
   * The head is a *later* position than the video's: the pitch shifter after
   * this player holds every sample for `shiftSamples`, so the sample fed now
   * is heard that much later, and it must be the sample the video will be
   * showing then. The head therefore runs `shiftSamples` ahead of the video,
   * and the video position implied by the current head is `head - shiftSamples`.
   *
   * A change beyond {@link JUMP_FRAMES} is a seek: fade out, land the head
   * when the fade has, fade back in. Anything smaller is drift, and stepping
   * it is the correction — four anchors a second mean the steps are sub-frame
   * anyway.
   */
  private land(mediaSeconds: number, rate: number): void {
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const to = Math.max(0, Number.isFinite(mediaSeconds) ? mediaSeconds : 0) * sampleRate;
    const latency = this.shiftSamples;
    const from = this.head - latency;
    if (Math.abs(to - from) >= JUMP_FRAMES) {
      this.pendingJump = { at: this.heard + JUMP_FADE_SECONDS, to: to + latency };
      this.master = rampTo(this.master, 0, this.heard, JUMP_FADE_SECONDS, 'smooth');
      return;
    }
    // A correction that lands where the video already is cancels any jump
    // still waiting to fire, and must undo that jump's fade as well.
    const wasJumping = this.pendingJump !== null;
    this.pendingJump = null;
    this.head = to + latency;
    if (wasJumping) {
      this.master = rampTo(this.master, this.masterTarget, this.heard, JUMP_FADE_SECONDS, 'smooth');
    }
  }

  /** Whether the head is past the frontier or the end, which is silence. */
  private ended(frame: number): boolean {
    return this.stems === null || frame < 0 || frame >= this.readyFrames;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0] ?? [];
    const left = out[0];
    if (left === undefined || this.stopped) {
      return !this.stopped;
    }
    const right = out[1];
    const frames = left.length;
    const voiceLeft = this.voice[0];
    const voiceRight = this.voice[1];
    if (voiceLeft === undefined || voiceRight === undefined) {
      return true;
    }
    voiceLeft.fill(0, 0, frames);
    voiceRight.fill(0, 0, frames);

    // A jump that has had its fade lands here, between quanta.
    const heard = this.heard;
    const jump = this.pendingJump;
    if (jump !== null && heard >= jump.at) {
      this.head = jump.to;
      this.pendingJump = null;
      this.master = rampTo(this.master, this.wantedMaster, heard, JUMP_FADE_SECONDS, 'smooth');
    }

    const stems = this.stems;
    if (this.draining && heard >= this.drainUntil) {
      this.draining = false;
    }
    const filling = stems !== null && (this.playing || this.draining);
    if (filling) {
      this.playFrame = Math.round(this.head - this.shiftSamples);
      for (let index = 0; index < frames; index += 1) {
        const frame = Math.round(this.head);
        if (this.ended(frame)) {
          // The track is over, or the stems have not reached here yet: keep
          // accepting anchors, so a seek back — a replay, a loop, or the
          // rest arriving — jumps in on the spot instead of waiting for the
          // next tick to revive the player. Nothing is fed from here on, so
          // the output is silence either way.
          this.playFrame = -1;
          this.master = rampTo(this.master, 0, heard + index / sampleRate, MUTE_SECONDS, 'smooth');
          break;
        }
        const at = heard + index / sampleRate;
        const master = gainAt(this.master, at);
        let sumLeft = 0;
        let sumRight = 0;
        for (let stem = 0; stem < STEMS.length; stem += 1) {
          if (this.duetActive && stem === 3) {
            // The single vocal stem is replaced by the pair, not added to it.
            continue;
          }
          const ramp = this.gains[stem];
          if (ramp === undefined) {
            continue;
          }
          const level = gainAt(ramp, at);
          sumLeft += level * (stems[stem * 2]?.[frame] ?? 0);
          sumRight += level * (stems[stem * 2 + 1]?.[frame] ?? 0);
        }
        if (this.duetActive && this.duet !== null) {
          const first = gainAt(this.duetGains[0] ?? heldGain(0), at) * (this.duet[0][frame] ?? 0);
          const second = gainAt(this.duetGains[1] ?? heldGain(0), at) * (this.duet[1][frame] ?? 0);
          sumLeft += first + second;
          sumRight += first + second;
        }
        voiceLeft[index] = master * sumLeft;
        voiceRight[index] = master * sumRight;
        this.head += this.rate;
      }
    } else {
      this.playFrame = -1;
    }

    // The pitch-shift node after this player is what delays the sound; the
    // head has already read ahead by that much, so the output goes straight
    // on.
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
    const report: StemPlayerReport = {
      type: 'playback',
      playFrame: this.playFrame,
      length: this.length,
    };
    this.port.postMessage(report);
  }
}

registerProcessor(STEM_PLAYER_PROCESSOR, StemPlayerProcessor);
