import { aboutText, prepareLabel } from '../audio/progress.ts';
import type { PlayMode, ResetReason, StatusReport } from '../protocol.ts';

/**
 * What the panel says, worked out from the last status report and nothing
 * else.
 *
 * Separated from the panel that draws it because the drawing is the easy part
 * and this is where the mistakes are: a reason that goes missing, controls
 * offered before there is anything to control, a wait with no explanation.
 * Pure, so the mapping is the test.
 *
 * There used to be a countdown here, walked down between reports with the
 * same function the audio side counted with. It is gone, and so is the
 * extrapolation: the preparing state is a bar and a line of words, both of
 * them straight out of the report, and the report now arrives four times a
 * second while there is something to say. A number this panel works out for
 * itself is a number that can disagree with the audio, and that is exactly
 * what the countdown did — it reached zero twelve seconds before there was
 * anything to hear.
 */

export type PanelState = 'off' | 'preparing' | 'live' | 'paused' | 'unsupported' | 'error';

export interface PanelView {
  readonly state: PanelState;
  /** The button's words. */
  readonly label: string;
  /** Where the bar is, nought to one, or null when there is no bar. */
  readonly progress: number | null;
  /** The one line under the bar: what is being waited for, and for how long. */
  readonly detail: string | null;
  /** Something that happened, which the bar starting over needs explaining by. */
  readonly note: string | null;
  /** Whether the mode switch and the guide slider belong on screen. */
  readonly controls: boolean;
  readonly mode: PlayMode;
  /** Where the guide slider sits, 0 to 100. */
  readonly guide: number;
}

export interface PanelInput {
  readonly report: StatusReport | null;
  /** Something only the person can do. Shown while nothing is running. */
  readonly hint?: string | null;
  /**
   * Whether the picture has just jumped back, which is what the `continue`
   * setting does at the moment it crosses over. Worth saying for a few
   * seconds, because a video that leaps backwards looks like a fault.
   */
  readonly jumped?: boolean;
}

/**
 * Chrome grants `tabCapture` off the back of a click in one of the extension's
 * own pages and nowhere else, so a button inside the page cannot start one. It
 * can only point at the one that can.
 */
export const TOOLBAR_HINT = 'Click the Kara icon in the toolbar to start';

/** The slider's position for a gain, and the gain for a position. */
export function guidePercent(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(level * 100)));
}

export function guideFromPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(1, Math.max(0, percent / 100));
}

/**
 * The note that explains why the video looks wrong. Without it the delay reads
 * as a bug, which it is not: it is the price of separating audio live.
 */
export function delayNote(delaySeconds: number | null, heldSeconds = 0): string | null {
  if (delaySeconds === null || !Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    return null;
  }
  const held = Number.isFinite(heldSeconds) ? Math.max(0, heldSeconds) : 0;
  return `picture is ${String(Math.round(delaySeconds + held))} s behind YouTube`;
}

/** What the `continue` setting does when it crosses over, in words. */
export function jumpedBackNote(delaySeconds: number | null): string | null {
  if (delaySeconds === null || !Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    return null;
  }
  return `jumped back ${String(Math.round(delaySeconds))} s`;
}

/**
 * Why it is getting ready again. A bar that starts over on its own reads as a
 * crash, so every reason that can throw the buffer away has a sentence.
 */
const REPRIME_NOTES: Readonly<Record<ResetReason, string>> = {
  seek: 'You jumped; preparing again',
  ratechange: 'The speed changed; preparing again',
  ended: 'The video ended; preparing again',
  navigation: 'Another video; preparing again',
  ad: 'An ad; preparing again after it',
};

export function reprimeNote(reason: ResetReason | null): string | null {
  return reason === null ? null : REPRIME_NOTES[reason];
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
  const mode: PlayMode = report?.mode ?? 'instrumental';
  const guide = guidePercent(report?.guide ?? 0);
  const quiet = { progress: null, note: null, controls: false, mode, guide };

  if (report === null || report.status === 'idle') {
    return { ...quiet, state: 'off', label: 'Karaoke', detail: input.hint ?? null };
  }

  if (report.status === 'priming') {
    return {
      ...quiet,
      state: 'preparing',
      label: 'Preparing',
      progress: report.prepare?.fraction ?? 0,
      detail: prepareDetail(report),
      note: reprimeNote(report.reprime),
    };
  }

  if (report.status === 'paused') {
    return {
      ...quiet,
      state: 'paused',
      label: 'Paused',
      // The one thing a person needs to know here, because the old behaviour
      // was to throw it all away and this one does not.
      detail: 'nothing lost; it carries on from here',
      controls: report.delaySeconds !== null,
    };
  }

  if (report.status === 'live') {
    return {
      ...quiet,
      state: 'live',
      label: 'Karaoke on',
      detail: delayNote(report.delaySeconds, report.heldSeconds),
      note: input.jumped === true ? jumpedBackNote(report.delaySeconds) : null,
      controls: true,
    };
  }

  return {
    ...quiet,
    state: report.status === 'unsupported' ? 'unsupported' : 'error',
    label: report.status === 'unsupported' ? 'Unavailable' : 'Failed',
    detail: report.reason ?? 'no reason given',
  };
}
