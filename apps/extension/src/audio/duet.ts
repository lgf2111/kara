/**
 * The duet voice pair, its two-channel mixer, and the helper connection.
 *
 * The normal mixer owns four stems. A duet result is a second, opt-in pair:
 * Voice 1 and Voice 2, both mono, both the length of the song. They are kept
 * separate from `StemMix` so the ordinary karaoke path does not grow a sixth
 * channel it never uses, and so a malformed duet message cannot change the
 * backing.
 *
 * The helper runs on loopback and requires a token. Both live in
 * `chrome.storage.local`; the popup is where they are entered.
 */

export type DuetState = 'off' | 'preparing' | 'ready' | 'error';

export type DuetPhase = 'starting' | 'separating' | 'mapping' | 'calibrating';

export interface DuetProgress {
  readonly phase: DuetPhase;
  readonly done: number;
  readonly total: number;
}

/** One level, mute and solo switch per voice, in Voice 1 / Voice 2 order. */
export interface DuetMix {
  readonly levels: readonly [number, number];
  readonly muted: readonly [boolean, boolean];
  readonly soloed: readonly [boolean, boolean];
}

export interface DuetStatus {
  readonly state: DuetState;
  readonly progress: DuetProgress | null;
  /** A line under the controls: the stage, an error, or a calibration hint. */
  readonly detail: string | null;
  readonly mix: DuetMix;
  /** Whether the worklet already holds a pair, even while it re-renders. */
  readonly hasVoices: boolean;
  /** Seconds the helper was unsure about, so the panel can warn honestly. */
  readonly lowConfidenceSeconds: number | null;
}

export const DUET_CONFIG_KEY = 'kara.duet';
export const DEFAULT_DUET_URL = 'http://127.0.0.1:8765';

export interface DuetConfig {
  readonly url: string;
  readonly token: string;
}

export const DEFAULT_DUET_CONFIG: DuetConfig = {
  url: DEFAULT_DUET_URL,
  token: '',
};

export const DEFAULT_DUET_MIX: DuetMix = {
  levels: [1, 1],
  muted: [false, false],
  soloed: [false, false],
};

export const IDLE_DUET: DuetStatus = {
  state: 'off',
  progress: null,
  detail: null,
  mix: DEFAULT_DUET_MIX,
  hasVoices: false,
  lowConfidenceSeconds: null,
};

export const DUET_LABEL = ['Voice 1', 'Voice 2'] as const;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function level(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A URL without a trailing slash, or the default when it is unreadable. */
export function normaliseDuetUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_DUET_URL;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) {
    return DEFAULT_DUET_URL;
  }
  return trimmed;
}

export function normaliseDuetConfig(raw: unknown): DuetConfig {
  const stored = recordOf(raw);
  return {
    url: normaliseDuetUrl(stored['url']),
    token: typeof stored['token'] === 'string' ? stored['token'].trim() : '',
  };
}

export function normaliseDuetMix(raw: unknown): DuetMix {
  const stored = recordOf(raw);
  const levels = Array.isArray(stored['levels']) ? stored['levels'] : [];
  const muted = Array.isArray(stored['muted']) ? stored['muted'] : [];
  const soloed = Array.isArray(stored['soloed']) ? stored['soloed'] : [];
  return {
    levels: [level(levels[0] ?? DEFAULT_DUET_MIX.levels[0]), level(levels[1] ?? DEFAULT_DUET_MIX.levels[1])],
    muted: [bool(muted[0], false), bool(muted[1], false)],
    soloed: [bool(soloed[0], false), bool(soloed[1], false)],
  };
}

export function withDuetLevel(mix: DuetMix, index: 0 | 1, value: unknown): DuetMix {
  const tidy = normaliseDuetMix(mix);
  const levels: [number, number] = [tidy.levels[0], tidy.levels[1]];
  levels[index] = level(value);
  return { ...tidy, levels };
}

export function withDuetMute(mix: DuetMix, index: 0 | 1, muted: unknown): DuetMix {
  const tidy = normaliseDuetMix(mix);
  const flags: [boolean, boolean] = [tidy.muted[0], tidy.muted[1]];
  flags[index] = muted === true;
  return { ...tidy, muted: flags };
}

export function withDuetSolo(mix: DuetMix, index: 0 | 1, soloed: unknown): DuetMix {
  const tidy = normaliseDuetMix(mix);
  const flags: [boolean, boolean] = [tidy.soloed[0], tidy.soloed[1]];
  flags[index] = soloed === true;
  return { ...tidy, soloed: flags };
}

/**
 * The two gains the worklet needs. The same desk rules as the four stems:
 * mute wins over solo, and any solo silences the other voice.
 */
export function duetGains(mix: DuetMix): readonly [number, number] {
  const tidy = normaliseDuetMix(mix);
  const soloing = tidy.soloed[0] || tidy.soloed[1];
  const gain = (index: 0 | 1): number => {
    if (tidy.muted[index]) {
      return 0;
    }
    if (soloing && !tidy.soloed[index]) {
      return 0;
    }
    return tidy.levels[index];
  };
  return [gain(0), gain(1)];
}

export function duetPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value * 100)));
}

/** Normalise a bridge phase string into the four phases the panel knows. */
export function duetPhaseOf(value: unknown): DuetPhase {
  switch (value) {
    case 'starting':
    case 'separating':
    case 'mapping':
    case 'calibrating':
      return value;
    default:
      return 'starting';
  }
}

/** The caption for a job phase, which is also what the panel shows. */
export function duetPhaseLabel(phase: DuetPhase | null): string {
  switch (phase) {
    case 'starting':
      return 'Starting the helper';
    case 'separating':
      return 'Splitting the two voices';
    case 'mapping':
      return 'Mapping who sings when';
    case 'calibrating':
      return 'Learning this line';
    default:
      return 'Splitting the two voices';
  }
}
