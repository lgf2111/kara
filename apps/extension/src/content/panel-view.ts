import { clampKey, KEY_DEFAULT, keyLabel } from '../audio/key.ts';
import {
  IDLE_MIC_STATUS,
  MONITOR_WARNING,
  normaliseMicStatus,
  type MicFx,
} from '../audio/mic-fx.ts';
import { aboutText, prepareLabel } from '../audio/progress.ts';
import { recordingTimer, type RecordingState } from '../audio/recording.ts';
import { DEFAULT_MIX, normaliseMix, type StemMix } from '../audio/stems.ts';
import {
  IDLE_DUET,
  duetPhaseLabel,
  normaliseDuetMix,
  type DuetMix,
  type DuetState,
} from '../audio/duet.ts';
import type { PracticeAnalysis } from '../audio/practice.ts';
import {
  keyName,
  rangeLabel,
  transposeLabel,
  type SongAnalysis,
} from '../audio/song-analysis.ts';
import type { PlayMode, StatusReport } from '../protocol.ts';

/**
 * What the panel says, worked out from the last status report and nothing
 * else.
 *
 * Separated from the panel that draws it because the drawing is the easy part
 * and this is where the mistakes are: a reason that goes missing, controls
 * offered before there is anything to control, a wait with no explanation.
 * Pure, so the mapping is the test.
 *
 * The old panel had a countdown to walk down and a delay to explain and a
 * reason for every reset. All three are gone with the delay: preparing is a
 * bar and a line of words straight out of the report, the toggle appears once
 * the separated audio covers the playhead — which can be before the bar is
 * full — and paused is one honest sentence.
 *
 * The mix is four levels and two switches each, not one guide: the player
 * holds drums, bass, other and vocals apart, so the panel can offer each of
 * them without a second separation. `audio/stems.ts` owns the values; this
 * file only passes them through, normalised, to the controls.
 */

export type PanelState = 'off' | 'preparing' | 'ready' | 'paused' | 'unsupported' | 'error';

export interface PanelView {
  readonly state: PanelState;
  /** The words for the primary action, or the status while preparing. */
  readonly label: string;
  /** Where the bar is, nought to one, or null when there is no bar. */
  readonly progress: number | null;
  /** The one line under the bar: what is being waited for, and for how long. */
  readonly detail: string | null;
  /** A line under the controls while the rest of the song is still arriving. */
  readonly note: string | null;
  /** Whether the mode switch, the mix and the key belong on screen. */
  readonly controls: boolean;
  readonly mode: PlayMode;
  /**
   * Each stem's slider position and its mute and solo switches, normalised
   * for the controls.
   */
  readonly mix: StemMix;
  /** The key, in whole semitones, and the words the control wears. */
  readonly semitones: number;
  readonly keyLabel: string;
  /** The opt-in Voice 1 / Voice 2 pair. */
  readonly duetState: DuetState;
  readonly duetLabel: string;
  readonly duetDetail: string | null;
  /** Done over total while a job is running, or null when it is not. */
  readonly duetProgress: number | null;
  readonly duetMix: DuetMix;
  readonly duetCanStart: boolean;
  readonly duetHasVoices: boolean;
  readonly duetLowConfidenceSeconds: number | null;
  /** Pitch practice: off, learning, listening, or stopped with a reason. */
  readonly practiceState: 'off' | 'analyzing' | 'ready' | 'error';
  readonly practiceLabel: string;
  readonly practiceDetail: string | null;
  /** Nought to one while the melody is being learnt, or null when it is not. */
  readonly practiceProgress: number | null;
  /** Whether the Practice button can begin a new run. */
  readonly practiceCanStart: boolean;
  /** Whether practice is the thing the player is showing right now. */
  readonly practiceActive: boolean;
  /** Key, tempo and range of the separated song, or the state of the read. */
  readonly songAnalysisState: 'off' | 'analyzing' | 'ready' | 'error';
  /** E.g. `G major`, or null when the key was not clear enough to show. */
  readonly songKey: string | null;
  /** Beats per minute, or null when the pulse was not clear enough to show. */
  readonly songBpm: number | null;
  /** E.g. `C3–E5`, or null when the vocal had too little to measure. */
  readonly songRange: string | null;
  /** E.g. `+2 semitones`, or the neutral `Original key`. */
  readonly songTranspose: string | null;
  /** The one line shown while the analysis runs or after it stops. */
  readonly songDetail: string | null;
  /** The microphone desk: five controls and a monitor that starts shut. */
  readonly mic: MicFx;
  readonly micWarning: string;
  /** Whether the stream is open, and whether the monitor is actually audible. */
  readonly micOn: boolean;
  readonly monitorOn: boolean;
  /** A microphone failure or the last saved filename, in one line. */
  readonly micDetail: string | null;
  readonly micError: boolean;
  readonly recordingState: RecordingState;
  readonly recordLabel: string;
  readonly recordTimer: string;
  readonly recordActive: boolean;
  readonly recordBusy: boolean;
}

export interface PanelInput {
  readonly report: StatusReport | null;
  /** The practice analysis from the offscreen document, when one was asked for. */
  readonly practice?: PracticeAnalysis | null;
  /** The song analysis from the offscreen document, when it has one. */
  readonly analysis?: SongAnalysis | null;
}

/** The stage and the estimate on one line, which is all there is room for. */
export function prepareDetail(report: StatusReport): string | null {
  const prepare = report.prepare;
  if (prepare === null) {
    return null;
  }
  const about = aboutText(prepare);
  const stage = prepareLabel(prepare);
  return about === null ? stage : `${stage} · ${about}`;
}

export function panelView(input: PanelInput): PanelView {
  const report = input.report;
  const mode: PlayMode = report?.mode ?? 'original';
  const mix = normaliseMix(report?.mix ?? DEFAULT_MIX);
  const semitones = clampKey(report?.semitones ?? KEY_DEFAULT);
  const duet = report?.duet ?? IDLE_DUET;
  const duetMix = normaliseDuetMix(duet.mix);
  const duetProgress =
    duet.progress !== null && duet.progress.total > 0
      ? duet.progress.done / duet.progress.total
      : null;
  const duetLabel =
    duet.state === 'ready'
      ? 'Duet ready'
      : duet.state === 'preparing'
        ? duetPhaseLabel(duet.progress?.phase ?? null)
        : duet.state === 'error'
          ? 'Duet stopped'
          : 'Duet (beta)';
  const duetDetail =
    duet.state === 'error'
      ? (duet.detail ?? 'the helper stopped')
      : duet.state === 'ready'
        ? duet.lowConfidenceSeconds !== null && duet.lowConfidenceSeconds > 10
          ? 'Some lines are uncertain. Use Fix line if a voice is wrong.'
          : null
        : duet.state === 'preparing'
          ? duet.hasVoices
            ? 'The current pair keeps playing while it re-renders.'
            : 'The normal vocal controls still work while this runs.'
          : null;
  const practice = input.practice ?? null;
  const practiceState: PanelView['practiceState'] = practice?.state ?? 'off';
  const practiceActive = practiceState === 'analyzing' || practiceState === 'ready';
  const practiceLabel =
    practiceState === 'analyzing'
      ? 'Learning the melody'
      : practiceState === 'ready'
        ? 'Practice on'
        : practiceState === 'error'
          ? 'Practice stopped'
          : 'Practice';
  const practiceDetail =
    practiceState === 'error'
      ? (practice?.detail ?? 'the microphone stopped')
      : practiceState === 'analyzing'
        ? (practice?.detail ?? 'Learning the guide melody.')
        : practiceState === 'ready'
          ? 'Wear headphones for accuracy.'
          : null;
  const practiceProgress =
    practiceState === 'analyzing' && practice?.progress !== null && practice?.progress !== undefined
      ? Math.min(1, Math.max(0, practice.progress))
      : null;
  const analysis = input.analysis ?? null;
  const songAnalysisState: PanelView['songAnalysisState'] = analysis?.state ?? 'off';
  const songFacts = songAnalysisState === 'ready' ? (analysis?.facts ?? null) : null;
  const songKey = songFacts?.key === null || songFacts?.key === undefined
    ? null
    : keyName(songFacts.key);
  const songBpm =
    songFacts?.bpm === null || songFacts?.bpm === undefined ? null : Math.round(songFacts.bpm);
  const songRange = songFacts?.range === null || songFacts?.range === undefined
    ? null
    : rangeLabel(songFacts.range);
  const songTranspose = songFacts === null ? null : transposeLabel(songFacts.transpose);
  const songDetail =
    songAnalysisState === 'analyzing'
      ? (analysis?.detail ?? 'Reading the song.')
      : songAnalysisState === 'error'
        ? (analysis?.detail ?? 'The song could not be read.')
        : null;
  const micDesk = normaliseMicStatus(report?.mic ?? IDLE_MIC_STATUS);
  const recording = micDesk.recording;
  const recordLabel =
    recording.state === 'recording'
      ? 'Stop'
      : recording.state === 'saving'
        ? 'Saving…'
        : recording.state === 'saved'
          ? 'Record again'
          : recording.state === 'error'
            ? 'Try again'
            : 'Record';
  const recordActive = recording.state === 'recording';
  const recordBusy = recording.state === 'saving';
  const micDetail =
    micDesk.error ??
    (recording.state === 'error'
      ? (recording.detail ?? 'The recording stopped.')
      : recording.state === 'saved'
        ? `Saved ${recording.filename ?? 'the take'}.`
        : null);
  const quiet = {
    progress: null,
    detail: null,
    note: null,
    controls: false,
    mode,
    mix,
    semitones,
    keyLabel: keyLabel(semitones),
    duetState: duet.state,
    duetLabel,
    duetDetail,
    duetProgress,
    duetMix,
    duetCanStart:
      report !== null && (report.status === 'ready' || report.status === 'paused'),
    duetHasVoices: duet.hasVoices,
    duetLowConfidenceSeconds: duet.lowConfidenceSeconds,
    practiceState,
    practiceLabel,
    practiceDetail,
    practiceProgress,
    practiceCanStart:
      report !== null &&
      (report.status === 'ready' || report.status === 'paused') &&
      !practiceActive,
    practiceActive,
    songAnalysisState,
    songKey,
    songBpm,
    songRange,
    songTranspose,
    songDetail,
    mic: micDesk.fx,
    micWarning: MONITOR_WARNING,
    micOn: micDesk.enabled,
    monitorOn: micDesk.monitor,
    micDetail,
    micError: micDesk.error !== null || recording.state === 'error',
    recordingState: recording.state,
    recordLabel,
    recordTimer: recordingTimer(recording.seconds),
    recordActive,
    recordBusy,
  };

  if (report === null || report.status === 'idle') {
    return { ...quiet, state: 'off', label: 'Start karaoke' };
  }

  if (report.status === 'preparing') {
    return {
      ...quiet,
      state: 'preparing',
      // Once the separated audio has caught up to the playhead the vocal
      // switch is usable, even though the rest of the track is still being
      // prepared behind it.
      label: 'Preparing karaoke',
      progress: report.prepare?.fraction ?? 0,
      detail: prepareDetail(report),
      note: report.covered ? 'the rest is still being prepared' : null,
      controls: report.covered,
    };
  }

  if (report.status === 'paused') {
    return {
      ...quiet,
      state: 'paused',
      // The video already says paused. The panel keeps every control usable
      // and says nothing about a state the person can see.
      label: 'Paused',
      controls: true,
    };
  }

  if (report.status === 'ready') {
    return {
      ...quiet,
      state: 'ready',
      label: 'Karaoke on',
      controls: true,
    };
  }

  return {
    ...quiet,
    state: report.status === 'unsupported' ? 'unsupported' : 'error',
    label: report.status === 'unsupported' ? 'Not available here' : 'Karaoke stopped',
    detail: report.reason ?? 'no reason given',
  };
}
