import { clampKey, keyLabel } from '../audio/key.ts';
import {
  DEFAULT_MIX,
  normaliseMix,
  STEM_LABEL,
  stemPercent,
  STEMS,
  type StemMix,
} from '../audio/stems.ts';
import {
  prepareDetail,
  plainReason,
  RETRY_ADVICE,
  UNSUPPORTED_ADVICE,
} from '../content/panel-view.ts';
import {
  cacheStatusLabel,
  formatBytes,
  normaliseCacheStatus,
} from '../cache/status.ts';
import type { PipelineDebug, StatusReport } from '../protocol.ts';

/**
 * What the popup says, worked out from the last status report, the tab it was
 * opened over, and the setting.
 *
 * The popup exists because, once there is a window, the state of the session
 * and the one setting may as well be somewhere a person can find them without
 * a video playing. Starting is no longer its exclusive job — the panel in the
 * page starts just as well now that there is no capture gesture — but the
 * popup remains the place for the state, the stop button and the remembered
 * key.
 *
 * Pure, so the mapping is the test. Nothing here touches `chrome`.
 */

export type PopupState = 'idle' | 'preparing' | 'ready' | 'paused' | 'unsupported' | 'error';

/** What the button does, which is the only thing in here that acts. */
export type PopupAction = 'start' | 'stop' | 'none';

export interface PopupDiagnosticRow {
  readonly label: string;
  readonly value: string;
  /** A value too long for the right-hand column, such as a backend reason. */
  readonly wide?: boolean;
}

export interface PopupDiagnosticGroup {
  readonly title: string;
  readonly rows: readonly PopupDiagnosticRow[];
}

/**
 * The raw session, grouped for the popup's diagnostics disclosure.
 *
 * The panel in the page is not the place for this: it floats over somebody
 * else's video and has one job. The popup is the window a person opens to
 * look, so the numbers live here, behind one click.
 */
export interface PopupDiagnostics {
  readonly groups: readonly PopupDiagnosticGroup[];
}

export interface PopupView {
  readonly state: PopupState;
  readonly headline: string;
  readonly detail: string | null;
  /** What to do about it, in one sentence, where there is something to do. */
  readonly advice: string | null;
  /** Where the bar is, nought to one, or null when there is no bar. */
  readonly progress: number | null;
  readonly action: PopupAction;
  readonly actionLabel: string;
  /** The key, and the words the control wears, both of them whole semitones. */
  readonly semitones: number;
  readonly keyLabel: string;
  /** Raw session and pipeline values, or null with nothing to diagnose. */
  readonly diagnostics: PopupDiagnostics | null;
}

/** What the popup's cache section needs to know about the store. */
export interface CacheUsageFacts {
  readonly bytes: number;
  readonly count: number;
  readonly limitBytes: number;
}

export interface CacheUsageView {
  /** `Cached: 14.8 MB · 1 song` or `Cache unavailable.` */
  readonly label: string;
  /** The line under it, when there is something useful to add. */
  readonly detail: string | null;
  readonly clearLabel: string;
  readonly clearDisabled: boolean;
}

export interface CacheUsageOptions {
  readonly busy?: boolean;
  readonly running?: boolean;
}

/**
 * The popup's small cache readout.
 *
 * Clearing is refused while a session runs: the offscreen document may be
 * writing the very entry being cleared. It is also refused with nothing
 * cached, because a button that does nothing is worse than no button.
 */
export function cacheUsageView(
  usage: CacheUsageFacts | null,
  options: CacheUsageOptions = {},
): CacheUsageView {
  if (usage === null) {
    return {
      label: 'Cache unavailable.',
      detail: 'Separated stems could not be read from storage.',
      clearLabel: 'Clear cache',
      clearDisabled: true,
    };
  }
  const busy = options.busy === true;
  const running = options.running === true;
  const label =
    usage.count === 0
      ? 'Cached: 0 B'
      : `Cached: ${formatBytes(usage.bytes)} · ${String(usage.count)} song${
          usage.count === 1 ? '' : 's'
        }`;
  const detail = running
    ? 'Stop the session before clearing the cache.'
    : usage.count === 0
      ? 'Separated stems are saved here; scores and settings are not.'
      : `Up to ${formatBytes(usage.limitBytes)} of separated stems. Scores and settings are not touched.`;
  return {
    label,
    detail,
    clearLabel: busy ? 'Clearing…' : 'Clear cache',
    clearDisabled: busy || running || usage.count === 0,
  };
}

export interface PopupInput {
  /** The last report for this tab, or null when there is none. */
  readonly report: StatusReport | null;
  /** The active tab's address, or undefined when there is no tab. */
  readonly url: string | undefined;
  /** The remembered default, which is what to show with nothing running. */
  readonly key: number;
  /** The offscreen document's debug state, when the popup has fetched one. */
  readonly pipeline?: PipelineDebug | null;
}

/** Where the panel works, which is one site. */
const SUPPORTED_HOST = 'www.youtube.com';

function hostOf(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** What is missing on a page that is not the one this was written for. */
export function pageNote(url: string | undefined): string | null {
  const host = hostOf(url);
  if (host === null || host === SUPPORTED_HOST || host.startsWith('localhost')) {
    return null;
  }
  return 'the on-page panel only works on YouTube';
}

/** What the popup says about the mixer, without listing four numbers. */
function vocalNote(mix: StemMix): string {
  const percent = stemPercent(mix.levels.vocals);
  if (mix.muted.vocals) {
    return `vocals muted at ${String(percent)}% — press M in the page`;
  }
  if (STEMS.some((stem) => stem !== 'vocals' && mix.soloed[stem])) {
    return 'another stem is soloed — the full mix is in the page';
  }
  if (mix.soloed.vocals) {
    return `vocals soloed at ${String(percent)}% — the full mix is in the page`;
  }
  if (percent === 0) {
    return 'vocals off — switch back with Original in the page';
  }
  if (percent === 100) {
    return 'vocals full — switch them off with Instrumental in the page';
  }
  return `vocals at ${String(percent)}% — the full mix is in the page`;
}

function sizeText(bytes: number): string {
  return formatBytes(bytes);
}

function downloadText(done: number, total: number | null): string {
  if (!Number.isFinite(done) || done <= 0) {
    return total === null || total <= 0 ? '—' : `0 B / ${sizeText(total)}`;
  }
  return total === null || total <= 0 ? sizeText(done) : `${sizeText(done)} / ${sizeText(total)}`;
}

function clockText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const whole = Math.round(seconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

function decimalSeconds(seconds: number | null): string {
  return seconds === null || !Number.isFinite(seconds) || seconds < 0
    ? '—'
    : `${seconds.toFixed(1)} s`;
}

function percentText(fraction: number | null): string {
  return fraction === null || !Number.isFinite(fraction)
    ? '—'
    : `${String(Math.round(fraction * 100))}%`;
}

function levelsText(mix: StemMix): string {
  return STEMS.map(
    (stem) => `${STEM_LABEL[stem][0] ?? '?'} ${String(stemPercent(mix.levels[stem]))}`,
  ).join(' · ');
}

function diagnosticsOf(
  report: StatusReport | null,
  pipeline: PipelineDebug | null,
  semitones: number,
  mix: StemMix,
): PopupDiagnostics | null {
  if (report === null && pipeline === null) {
    return null;
  }
  const prepare = report?.prepare ?? null;
  const metrics = pipeline?.metrics ?? null;
  const muted = STEMS.filter((stem) => mix.muted[stem]);
  const soloed = STEMS.filter((stem) => mix.soloed[stem]);
  const switches = [
    ...muted.map((stem) => `${STEM_LABEL[stem].toLowerCase()} muted`),
    ...soloed.map((stem) => `${STEM_LABEL[stem].toLowerCase()} soloed`),
  ];
  const groups: PopupDiagnosticGroup[] = [
    {
      title: 'Session',
      rows: [
        { label: 'Status', value: report?.status ?? pipeline?.status ?? 'idle' },
        { label: 'Stage', value: prepare?.stage ?? '—' },
        { label: 'Progress', value: percentText(prepare?.fraction ?? null) },
        {
          label: 'Pieces',
          value:
            prepare?.pieces === null || prepare?.pieces === undefined
              ? '—'
              : `${String(prepare.pieces.loaded)} / ${String(prepare.pieces.total)}`,
        },
        { label: 'Covered', value: report === null ? '—' : report.covered ? 'yes' : 'no' },
        {
          label: 'ETA',
          value:
            prepare?.aboutSeconds === null || prepare?.aboutSeconds === undefined
              ? '—'
              : `~${String(Math.round(prepare.aboutSeconds))} s`,
        },
        { label: 'Analysed', value: clockText(report?.analyzedSeconds ?? null) },
        { label: 'Length', value: clockText(report?.durationSeconds ?? null) },
        {
          label: 'Cache',
          value: cacheStatusLabel(normaliseCacheStatus(report?.cache ?? null)) ?? '—',
        },
      ],
    },
    {
      title: 'Analysis',
      rows: [
        { label: 'Backend', value: pipeline?.backend ?? 'not loaded' },
        {
          label: 'Windows',
          value:
            metrics === null
              ? '—'
              : `${String(metrics.windowsDone)} / ${String(metrics.windowsTotal)}`,
        },
        {
          label: 'Compute',
          value:
            metrics?.computeMs === null || metrics?.computeMs === undefined
              ? '—'
              : `${String(Math.round(metrics.computeMs))} ms`,
        },
        {
          label: 'Download',
          value: metrics === null ? '—' : downloadText(metrics.downloadBytes, metrics.downloadTotal),
        },
        { label: 'Rate', value: pipeline === null ? '—' : `${String(pipeline.sampleRate)} Hz` },
        ...(pipeline?.backendReason === null || pipeline?.backendReason === undefined
          ? []
          : [{ label: 'Why', value: pipeline.backendReason, wide: true }]),
      ],
    },
    {
      title: 'Audio',
      rows: [
        { label: 'Mode', value: report?.mode ?? '—' },
        { label: 'Key', value: keyLabel(semitones) },
        { label: 'Levels', value: levelsText(mix), wide: true },
        { label: 'Switches', value: switches.length === 0 ? '—' : switches.join(', ') },
        { label: 'Playhead', value: decimalSeconds(metrics?.mediaSeconds ?? null) },
        {
          label: 'Stems',
          value:
            metrics === null || pipeline === null || pipeline.sampleRate <= 0
              ? '—'
              : decimalSeconds(metrics.stemFrames / pipeline.sampleRate),
        },
        { label: 'Mic', value: report?.mic?.enabled === true ? 'open' : 'off' },
        { label: 'Monitor', value: report?.mic?.monitor === true ? 'on' : 'off' },
        { label: 'Recording', value: report?.mic?.recording.state ?? 'idle' },
      ],
    },
  ];
  return { groups };
}

export function popupView(input: PopupInput): PopupView {
  const report = input.report;
  // The running session over the remembered default, same as the setting:
  // what is playing now is what the person is looking at the popup to change.
  const semitones = clampKey(report?.semitones ?? input.key);
  const mix = normaliseMix(report?.mix ?? DEFAULT_MIX);
  const diagnostics = diagnosticsOf(report, input.pipeline ?? null, semitones, mix);
  const quiet = {
    progress: null,
    advice: null,
    semitones,
    keyLabel: keyLabel(semitones),
    diagnostics,
  };

  if (report === null || report.status === 'idle') {
    return {
      ...quiet,
      state: 'idle',
      headline: 'Not running',
      detail:
        pageNote(input.url) ??
        'Reads this video\u2019s audio, takes the vocal out, and lets you switch it on and off.',
      advice: null,
      action: 'start',
      actionLabel: 'Start',
    };
  }

  if (report.status === 'preparing') {
    return {
      ...quiet,
      state: 'preparing',
      headline: 'Getting ready',
      progress: report.prepare?.fraction ?? 0,
      detail: prepareDetail(report),
      advice: null,
      action: 'stop',
      actionLabel: 'Stop',
    };
  }

  if (report.status === 'paused') {
    return {
      ...quiet,
      state: 'paused',
      headline: 'Paused',
      detail: null,
      advice: null,
      action: 'stop',
      actionLabel: 'Stop',
    };
  }

  if (report.status === 'ready') {
    return {
      ...quiet,
      state: 'ready',
      headline: 'Ready',
      detail:
        report.mode === 'instrumental'
          ? vocalNote(mix)
          : 'vocals on — switch them off with Instrumental in the page',
      advice: null,
      action: 'stop',
      actionLabel: 'Stop',
    };
  }

  if (report.status === 'unsupported') {
    return {
      ...quiet,
      state: 'unsupported',
      headline: 'Kara cannot run on this machine',
      detail: report.reason,
      advice: UNSUPPORTED_ADVICE,
      action: 'stop',
      actionLabel: 'Stop',
    };
  }

  return {
    ...quiet,
    state: 'error',
    headline: 'It went wrong',
    // Same translation as the panel: a plain sentence here, the raw text in
    // diagnostics, and a next step under both.
    detail: report.reason === null ? null : plainReason(report.reason),
    advice: RETRY_ADVICE,
    action: 'stop',
    actionLabel: 'Stop',
  };
}
