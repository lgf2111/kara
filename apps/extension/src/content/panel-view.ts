import { clampKey, KEY_DEFAULT, keyLabel } from '../audio/key.ts';
import { aboutText, prepareLabel } from '../audio/progress.ts';
import { DEFAULT_MIX, normaliseMix, type StemMix } from '../audio/stems.ts';
import {
  IDLE_DUET,
  duetPhaseLabel,
  normaliseDuetMix,
  type DuetMix,
  type DuetState,
} from '../audio/duet.ts';
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
}

export interface PanelInput {
  readonly report: StatusReport | null;
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
