/**
 * The optional Duet sidecar: two mono voices and the helper's voice map.
 *
 * The four stems keep their own format, key and metadata. A duet is a second
 * layer inside the same entry directory, with its own version number so a
 * helper change can invalidate the voices without throwing away the stems.
 * Everything here is pure shape and parsing; the store owns the atomic write
 * and the OPFS layer owns the files.
 */

/** The sidecar format this build writes and reads. */
export const DUET_FORMAT_VERSION = 1;

/** The most a helper map may take in the cache; it is diagnostic metadata. */
export const MAX_DUET_MAP_BYTES = 1024 * 1024;

export const MAX_DUET_HELPER_VERSION_LENGTH = 80;
export const MAX_DUET_MODEL_VERSION_LENGTH = 80;

/** One calibration line the helper used, in seconds. */
export interface DuetAnchor {
  readonly voice: 1 | 2;
  readonly start: number;
  readonly end: number;
}

/** The helper's own seconds-per-kind readout, kept open-ended for additions. */
export type DuetQuality = Readonly<Record<string, number>>;

/**
 * The helper's map document. Only the fields the cache needs are known here;
 * the rest is preserved so a diagnostics view can read it back unchanged.
 */
export type DuetMap = Readonly<Record<string, unknown>>;

/** One voice or the other, as the engine receives them from the helper. */
export type DuetVoices =
  | readonly [Float32Array, Float32Array]
  | {
      readonly voice1: Float32Array;
      readonly voice2: Float32Array;
    };

/** A returned pair that reads both as a tuple and by voice name. */
export type CachedDuetVoicePair = readonly [Float32Array, Float32Array] & {
  readonly voice1: Float32Array;
  readonly voice2: Float32Array;
};

export function duetVoicePair(
  voice1: Float32Array,
  voice2: Float32Array,
): CachedDuetVoicePair {
  const pair = [voice1, voice2] as unknown as CachedDuetVoicePair;
  return Object.assign(pair, { voice1, voice2 });
}

/** What a caller writes: the audio, the map, and the versions that made them. */
export interface CachedDuetInput {
  readonly voices: DuetVoices;
  readonly map: unknown;
  readonly helperVersion: string;
  readonly duetFormatVersion: number;
  readonly modelVersion?: string;
}

/** The small part of a duet the entry metadata remembers. */
export interface CachedDuetMeta {
  /** Bytes of the two voice files and the JSON sidecar together. */
  readonly bytes: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly duetFormatVersion: number;
  readonly helperVersion: string;
  readonly modelVersion?: string;
}

/** A duet read back from disk. */
export interface CachedDuet {
  readonly key: string;
  readonly sampleRate: number;
  readonly frames: number;
  readonly voices: CachedDuetVoicePair;
  /** Convenience aliases for callers that name the voices directly. */
  readonly voice1: Float32Array;
  readonly voice2: Float32Array;
  readonly map: DuetMap;
  readonly quality: DuetQuality;
  readonly anchors: readonly DuetAnchor[];
  readonly helperVersion: string;
  readonly modelVersion: string | null;
  readonly duetFormatVersion: number;
}

/** Optional expectations a caller can hold the sidecar to. */
export interface DuetExpectation {
  readonly helperVersion?: string;
  readonly duetFormatVersion?: number;
}

/** The JSON document stored as `duet.json`. */
export interface DuetSidecar {
  readonly duetFormatVersion: number;
  readonly helperVersion: string;
  readonly modelVersion: string | null;
  readonly sampleRate: number;
  readonly frames: number;
  readonly map: DuetMap;
  readonly quality: DuetQuality;
  readonly anchors: readonly DuetAnchor[];
}

export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integer(value: unknown, min: number): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= min
    ? value
    : null;
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim().slice(0, limit).trim()
    : '';
}

export function normaliseDuetHelperVersion(value: unknown): string {
  return text(value, MAX_DUET_HELPER_VERSION_LENGTH);
}

export function normaliseDuetModelVersion(value: unknown): string {
  return text(value, MAX_DUET_MODEL_VERSION_LENGTH);
}

/** The map as a plain object, or an empty one when it is unreadable. */
export function normaliseDuetMap(value: unknown): DuetMap {
  return recordOf(value);
}

/** The anchors in the helper's map, dropping malformed entries one by one. */
export function duetAnchorsOf(map: DuetMap): readonly DuetAnchor[] {
  const raw = map['anchors'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const anchors: DuetAnchor[] = [];
  for (const item of raw) {
    const stored = recordOf(item);
    const voice = stored['voice'];
    const start = stored['start'];
    const end = stored['end'];
    if (
      (voice !== 1 && voice !== 2) ||
      typeof start !== 'number' ||
      !Number.isFinite(start) ||
      typeof end !== 'number' ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    ) {
      continue;
    }
    anchors.push({ voice, start, end });
  }
  return anchors;
}

/** The helper's quality numbers, with malformed fields dropped. */
export function duetQualityOf(map: DuetMap): DuetQuality {
  const raw = recordOf(map['quality']);
  const quality: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      quality[name] = value;
    }
  }
  return quality;
}

/** One voice pair out of either accepted input shape. */
export function normaliseDuetVoices(
  voices: unknown,
): readonly [Float32Array, Float32Array] | null {
  if (Array.isArray(voices)) {
    if (voices.length !== 2) {
      return null;
    }
    const first = voices[0];
    const second = voices[1];
    return first instanceof Float32Array && second instanceof Float32Array
      ? [first, second]
      : null;
  }
  const stored = recordOf(voices);
  const first = stored['voice1'];
  const second = stored['voice2'];
  return first instanceof Float32Array && second instanceof Float32Array
    ? [first, second]
    : null;
}

/** Builds the JSON document from a validated write request. */
export function buildDuetSidecar(
  input: {
    readonly sampleRate: number;
    readonly frames: number;
    readonly helperVersion: string;
    readonly modelVersion: string | null;
    readonly duetFormatVersion: number;
    readonly map: DuetMap;
  },
): DuetSidecar {
  return {
    duetFormatVersion: input.duetFormatVersion,
    helperVersion: input.helperVersion,
    modelVersion: input.modelVersion,
    sampleRate: input.sampleRate,
    frames: input.frames,
    map: input.map,
    quality: duetQualityOf(input.map),
    anchors: duetAnchorsOf(input.map),
  };
}

/** Parses a stored `duet.json` string, or null when it is not this shape. */
export function parseDuetSidecar(raw: string): DuetSidecar | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const stored = recordOf(value);
  const duetFormatVersion = integer(stored['duetFormatVersion'], 0);
  const helperVersion = normaliseDuetHelperVersion(stored['helperVersion']);
  const sampleRate = integer(stored['sampleRate'], 0);
  const frames = integer(stored['frames'], 1);
  if (
    duetFormatVersion === null ||
    helperVersion === '' ||
    sampleRate === null ||
    frames === null
  ) {
    return null;
  }
  const map = normaliseDuetMap(stored['map']);
  const modelVersion = normaliseDuetModelVersion(stored['modelVersion']);
  return {
    duetFormatVersion,
    helperVersion,
    modelVersion: modelVersion === '' ? null : modelVersion,
    sampleRate,
    frames,
    map,
    quality: duetQualityOf(map),
    anchors: duetAnchorsOf(map),
  };
}

/** The entry record's optional duet part, or undefined when it is malformed. */
export function normaliseCachedDuetMeta(
  raw: unknown,
  entry: { readonly frames: number; readonly sampleRate: number },
): CachedDuetMeta | undefined {
  const stored = recordOf(raw);
  const bytes = integer(stored['bytes'], 1);
  const frames = integer(stored['frames'], 1);
  const sampleRate = integer(stored['sampleRate'], 8000);
  const duetFormatVersion = integer(stored['duetFormatVersion'], 0);
  const helperVersion = normaliseDuetHelperVersion(stored['helperVersion']);
  if (
    bytes === null ||
    frames === null ||
    sampleRate === null ||
    duetFormatVersion === null ||
    helperVersion === '' ||
    frames !== entry.frames ||
    sampleRate !== entry.sampleRate ||
    sampleRate > 384000
  ) {
    return undefined;
  }
  const modelVersion = normaliseDuetModelVersion(stored['modelVersion']);
  return {
    bytes,
    frames,
    sampleRate,
    duetFormatVersion,
    helperVersion,
    ...(modelVersion === '' ? {} : { modelVersion }),
  };
}
