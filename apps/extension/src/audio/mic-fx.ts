/**
 * The microphone desk: five controls and the numbers the audio graph needs.
 *
 * The graph is deliberately small and KTV-shaped. A high-pass keeps rumble
 * out of the effects, one peaking band is the tone control, and a compressor
 * makes a singer who moves away from the microphone still audible. Reverb is
 * a synthetic impulse rather than a sample, and echo is a feedback delay:
 * both are local, both are deterministic, and neither needs a file.
 *
 * **Monitoring is the dangerous control.** A microphone played through the
 * same speakers as the backing is a feedback loop, so the monitor gain starts
 * at nought and only a person who has been told to use headphones can raise
 * it. Recording does not need the monitor: the microphone is processed into
 * the recording bus whichever way that switch sits.
 *
 * Everything in here is pure. `audio/mic-graph.ts` turns the parameters into
 * Web Audio nodes, and the panel passes the whole desk back as one object, the
 * same way the stem mixer works.
 */

import { IDLE_RECORDING, normaliseRecording, type RecordingStatus } from './recording.ts';

/** The five controls, plus the switch that must stay off by default. */
export interface MicFx {
  /** Input gain, nought to one. */
  readonly level: number;
  /** Whether the processed microphone is also sent to the speakers. */
  readonly monitor: boolean;
  /** How much synthetic reverb is mixed in. */
  readonly reverb: number;
  /** How much feedback echo is mixed in. */
  readonly echo: number;
  /** A tilt around the middle: nought is darker, one is brighter. */
  readonly tone: number;
  /** How hard the compressor works, nought to one. */
  readonly compression: number;
}

/** The warning beside the monitor switch, in one place so every view says it. */
export const MONITOR_WARNING = 'Use headphones to avoid feedback.';

/**
 * A tasteful starting desk. The microphone is audible at 85%, the effects are
 * present but not a caricature, and the monitor is off.
 */
export const DEFAULT_MIC_FX: MicFx = {
  level: 0.85,
  monitor: false,
  reverb: 0.2,
  echo: 0.15,
  tone: 0.5,
  compression: 0.35,
};

export function micLevel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A desk out of storage or a message.
 *
 * Every unreadable number falls back to its default and every readable one is
 * clamped: a slider that arrived at 140 asked for as much as there is, while a
 * message that lost a field must not silently mute the microphone. The monitor
 * is only ever on when it says so explicitly.
 */
export function normaliseMicFx(raw: unknown): MicFx {
  const stored = recordOf(raw);
  const level = stored['level'];
  const reverb = stored['reverb'];
  const echo = stored['echo'];
  const tone = stored['tone'];
  const compression = stored['compression'];
  return {
    level:
      typeof level === 'number' && Number.isFinite(level)
        ? micLevel(level)
        : DEFAULT_MIC_FX.level,
    monitor: stored['monitor'] === true,
    reverb:
      typeof reverb === 'number' && Number.isFinite(reverb)
        ? micLevel(reverb)
        : DEFAULT_MIC_FX.reverb,
    echo:
      typeof echo === 'number' && Number.isFinite(echo)
        ? micLevel(echo)
        : DEFAULT_MIC_FX.echo,
    tone:
      typeof tone === 'number' && Number.isFinite(tone)
        ? micLevel(tone)
        : DEFAULT_MIC_FX.tone,
    compression:
      typeof compression === 'number' && Number.isFinite(compression)
        ? micLevel(compression)
        : DEFAULT_MIC_FX.compression,
  };
}

/** The desk with one or more controls moved, as a new object. */
export function withMicFx(current: MicFx, patch: Partial<MicFx>): MicFx {
  return normaliseMicFx({ ...current, ...patch });
}

/** The numbers the graph sets, all of them plain and testable. */
export interface MicFxParams {
  readonly inputGain: number;
  readonly highpassHz: number;
  readonly toneHz: number;
  readonly toneGainDb: number;
  readonly compressorThresholdDb: number;
  readonly compressorKneeDb: number;
  readonly compressorRatio: number;
  readonly reverbWet: number;
  readonly reverbSeconds: number;
  readonly echoWet: number;
  readonly echoSeconds: number;
  readonly echoFeedback: number;
  readonly monitorGain: number;
}

/**
 * The controls as audio parameters.
 *
 * Tone is a gentle ±6 dB peak at 3.2 kHz, where consonants live. Compression
 * starts as a ratio of one, which is no compression at all, and reaches 8:1 at
 * a threshold of −36 dB; the knee is wide so quiet singing is not gated. The
 * effect sends are gains, not percentages, and the monitor is either open or
 * shut — the level already lives at the input.
 */
export function micFxParams(fx: MicFx): MicFxParams {
  const tidy = normaliseMicFx(fx);
  return {
    inputGain: tidy.level,
    highpassHz: 90,
    toneHz: 3200,
    toneGainDb: (tidy.tone - 0.5) * 12,
    compressorThresholdDb: -36 * tidy.compression,
    compressorKneeDb: 24,
    compressorRatio: 1 + 7 * tidy.compression,
    reverbWet: tidy.reverb * 0.8,
    reverbSeconds: 1.2 + tidy.reverb * 1.2,
    echoWet: tidy.echo * 0.65,
    echoSeconds: 0.22 + tidy.echo * 0.18,
    echoFeedback: 0.15 + tidy.echo * 0.4,
    monitorGain: tidy.monitor ? 1 : 0,
  };
}

/** What the engine reports about the microphone desk. */
export interface MicStatus {
  /** The controls, as last asked for. */
  readonly fx: MicFx;
  /** Whether the stream and graph are open. */
  readonly enabled: boolean;
  /** Whether the monitor is actually audible, which requires the stream. */
  readonly monitor: boolean;
  /** Why the microphone could not be opened, or null. */
  readonly error: string | null;
  readonly recording: RecordingStatus;
}

export const IDLE_MIC_STATUS: MicStatus = {
  fx: DEFAULT_MIC_FX,
  enabled: false,
  monitor: false,
  error: null,
  recording: IDLE_RECORDING,
};

/** A microphone report from storage or a message, made safe to draw. */
export function normaliseMicStatus(raw: unknown): MicStatus {
  const stored = recordOf(raw);
  const enabled = stored['enabled'] === true;
  const error = stored['error'];
  return {
    fx: normaliseMicFx(stored['fx']),
    enabled,
    monitor: enabled && stored['monitor'] === true,
    error: typeof error === 'string' && error.trim() !== '' ? error.trim() : null,
    recording: normaliseRecording(stored['recording']),
  };
}
