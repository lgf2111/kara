import { DEFAULT_MIC_FX, micFxParams, type MicFx, type MicFxParams } from './mic-fx.ts';

/**
 * The microphone effects graph, built once when the microphone opens.
 *
 * ```text
 * source → input → highpass → tone → compressor ─┬→ dry ─────────────┐
 *                                                 ├→ reverb → wet ────┤
 *                                                 └→ echo → wet ──────┤
 *                                                        ↺ feedback   │
 *                                                                     ▼
 *                                              monitor → speakers   record → recorder
 * ```
 *
 * The two destinations are separate on purpose. The monitor can be shut while
 * the recording bus stays open, which is the normal way somebody records
 * without headphones. The reverb is a generated impulse — a decaying burst of
 * deterministic noise — so the extension ships no audio and fetches nothing.
 *
 * Kept apart from `offscreen/mic-room.ts` so the graph can be built against
 * fake Web Audio nodes in a test. Nothing here touches the microphone itself.
 */

/** How long the synthetic room rings for, before the wet control scales it. */
const REVERB_SECONDS = 2.4;

/** Smoothing for every parameter change, so a slider cannot click. */
const PARAM_SECONDS = 0.02;

export interface MicGraph {
  /** Where the microphone source connects. */
  readonly input: AudioNode;
  /** Move every parameter to match the desk. */
  readonly apply: (fx: MicFx, now: number) => void;
  /** Remove every connection this graph owns. */
  readonly disconnect: () => void;
}

/** A decaying noise burst, the same on every run and every machine. */
export function reverbImpulse(context: AudioContext): AudioBuffer {
  const rate = Number.isFinite(context.sampleRate) && context.sampleRate > 0
    ? context.sampleRate
    : 48_000;
  const frames = Math.max(1, Math.round(rate * REVERB_SECONDS));
  const buffer = context.createBuffer(2, frames, rate);
  let seed = 0x2f6e2b1;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame += 1) {
      // A linear congruential generator: cheap, repeatable, and noise is all
      // the impulse needs to be.
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const noise = (seed / 0xffff_ffff) * 2 - 1;
      const decay = Math.pow(1 - frame / frames, 2.6);
      data[frame] = noise * decay * 0.6;
    }
  }
  return buffer;
}

function ramp(param: AudioParam, value: number, now: number): void {
  if (!Number.isFinite(value)) {
    return;
  }
  param.setTargetAtTime(value, Math.max(0, now), PARAM_SECONDS);
}

function setFilter(
  filter: BiquadFilterNode,
  type: BiquadFilterType,
  frequency: number,
  q: number,
): void {
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
}

export function createMicGraph(
  context: AudioContext,
  monitor: AudioNode,
  record: AudioNode,
): MicGraph {
  const input = context.createGain();
  const highpass = context.createBiquadFilter();
  setFilter(highpass, 'highpass', 90, 0.7);

  const tone = context.createBiquadFilter();
  setFilter(tone, 'peaking', 3200, 1);

  const compressor = context.createDynamicsCompressor();
  compressor.knee.value = 24;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  const dry = context.createGain();
  const reverbSend = context.createGain();
  const reverb = context.createConvolver();
  reverb.buffer = reverbImpulse(context);
  const reverbWet = context.createGain();
  const echoSend = context.createGain();
  const delay = context.createDelay(1);
  const echoWet = context.createGain();
  const feedback = context.createGain();
  const mix = context.createGain();
  const monitorGain = context.createGain();

  input.connect(highpass);
  highpass.connect(tone);
  tone.connect(compressor);
  compressor.connect(dry);
  dry.connect(mix);
  compressor.connect(reverbSend);
  reverbSend.connect(reverb);
  reverb.connect(reverbWet);
  reverbWet.connect(mix);
  compressor.connect(echoSend);
  echoSend.connect(delay);
  delay.connect(echoWet);
  echoWet.connect(mix);
  delay.connect(feedback);
  feedback.connect(delay);
  mix.connect(monitorGain);
  monitorGain.connect(monitor);
  mix.connect(record);

  const nodes: readonly AudioNode[] = [
    input,
    highpass,
    tone,
    compressor,
    dry,
    reverbSend,
    reverb,
    reverbWet,
    echoSend,
    delay,
    echoWet,
    feedback,
    mix,
    monitorGain,
  ];

  const apply = (fx: MicFx, now: number): void => {
    const params: MicFxParams = micFxParams(fx);
    ramp(input.gain, params.inputGain, now);
    ramp(highpass.frequency, params.highpassHz, now);
    ramp(tone.frequency, params.toneHz, now);
    ramp(tone.gain, params.toneGainDb, now);
    ramp(compressor.threshold, params.compressorThresholdDb, now);
    ramp(compressor.knee, params.compressorKneeDb, now);
    ramp(compressor.ratio, params.compressorRatio, now);
    ramp(dry.gain, 1, now);
    ramp(reverbSend.gain, 1, now);
    ramp(reverbWet.gain, params.reverbWet, now);
    ramp(echoSend.gain, 1, now);
    ramp(delay.delayTime, params.echoSeconds, now);
    ramp(echoWet.gain, params.echoWet, now);
    ramp(feedback.gain, params.echoFeedback, now);
    // A little headroom before the two destinations: the dry path, the room
    // and the echo can otherwise add up past one on a loud consonant.
    ramp(mix.gain, 0.9, now);
    ramp(monitorGain.gain, params.monitorGain, now);
  };

  apply(DEFAULT_MIC_FX, context.currentTime);

  return {
    input,
    apply,
    disconnect() {
      for (const node of nodes) {
        node.disconnect();
      }
    },
  };
}
