import { primingSecondsLeft } from '../audio/status.ts';
import type { PlayMode, StatusReport } from '../protocol.ts';

/**
 * What the panel says, worked out from the last status report and nothing
 * else.
 *
 * Separated from the panel that draws it because the drawing is the easy part
 * and this is where the mistakes are: a countdown that does not reach zero, a
 * reason that goes missing, controls offered before there is anything to
 * control. Pure, so the mapping is the test.
 *
 * The one piece of state that is not in the report is the countdown. A report
 * arrives when something changes, not every second, so its `secondsLeft` is
 * only true at the instant it was sent; `sinceMs` is how long ago that was and
 * the countdown is walked down from there with the same function the audio
 * side counts with.
 */

export type PanelState = 'off' | 'preparing' | 'live' | 'unsupported' | 'error';

export interface PanelView {
  readonly state: PanelState;
  /** The button's words. */
  readonly label: string;
  /** One line under the button, or nothing. */
  readonly detail: string | null;
  /** Whether the mode switch and the guide slider belong on screen. */
  readonly controls: boolean;
  readonly mode: PlayMode;
  /** Where the guide slider sits, 0 to 100. */
  readonly guide: number;
}

export interface PanelInput {
  readonly report: StatusReport | null;
  /** Milliseconds since that report arrived, so the countdown can tick. */
  readonly sinceMs?: number;
  /** Something only the person can do. Shown while nothing is running. */
  readonly hint?: string | null;
}

/**
 * Chrome grants `tabCapture` off the back of a click on the extension's own
 * button and nowhere else, so a button inside the page cannot start one. It
 * can only say so.
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
export function delayNote(delaySeconds: number | null): string | null {
  if (delaySeconds === null || !Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    return null;
  }
  return `picture is ${String(Math.round(delaySeconds))} s behind YouTube`;
}

function countdown(report: StatusReport, sinceMs: number): number | null {
  if (report.secondsLeft === null) {
    return null;
  }
  return primingSecondsLeft(0, sinceMs, report.secondsLeft);
}

export function panelView(input: PanelInput): PanelView {
  const report = input.report;
  const mode: PlayMode = report?.mode ?? 'instrumental';
  const guide = guidePercent(report?.guide ?? 0);

  if (report === null || report.status === 'idle') {
    return {
      state: 'off',
      label: 'Karaoke',
      detail: input.hint ?? null,
      controls: false,
      mode,
      guide,
    };
  }

  if (report.status === 'priming') {
    const left = countdown(report, input.sinceMs ?? 0);
    return {
      state: 'preparing',
      label: left === null ? 'Preparing' : `Preparing ${String(Math.ceil(left))} s`,
      // Loading the model is the slow part of a first prime and the one worth
      // saying out loud, and it arrives as the status's reason.
      detail: report.reason,
      controls: false,
      mode,
      guide,
    };
  }

  if (report.status === 'live') {
    return {
      state: 'live',
      label: 'Karaoke on',
      detail: delayNote(report.delaySeconds),
      controls: true,
      mode,
      guide,
    };
  }

  return {
    state: report.status === 'unsupported' ? 'unsupported' : 'error',
    label: report.status === 'unsupported' ? 'Unavailable' : 'Failed',
    detail: report.reason ?? 'no reason given',
    controls: false,
    mode,
    guide,
  };
}
