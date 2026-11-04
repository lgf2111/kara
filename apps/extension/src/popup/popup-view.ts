import { clampKey, keyLabel } from '../audio/key.ts';
import { delayNote, prepareDetail, reprimeNote } from '../content/panel-view.ts';
import type { OnReady, StatusReport } from '../protocol.ts';

/**
 * What the popup says, worked out from the last status report, the tab it was
 * opened over, and the setting.
 *
 * The popup exists for one reason that is not about looks: Chrome grants
 * `chrome.tabCapture.getMediaStreamId` off the back of a click in one of the
 * extension's own contexts, and with a popup set on the action,
 * `chrome.action.onClicked` never fires at all. So the click that starts a
 * capture now lands here. Everything else it shows is there because, once
 * there is a window, the state of the capture and the one setting may as well
 * be somewhere a person can find them without a video playing.
 *
 * Two of the sentences are shared with the panel in the page rather than
 * written twice: what getting ready is doing, and how far behind the picture
 * is. They are the same facts about the same capture, and words that drift
 * apart between two windows are worse than an import across a folder. The key
 * is a third: the same control, with the same words, except that this is the
 * one that is also remembered.
 *
 * Pure, so the mapping is the test. Nothing here touches `chrome`.
 */

export type PopupState = 'idle' | 'preparing' | 'live' | 'paused' | 'unsupported' | 'error';

/** What the button does, which is the only thing in here that acts. */
export type PopupAction = 'start' | 'stop' | 'none';

export interface PopupView {
  readonly state: PopupState;
  readonly headline: string;
  readonly detail: string | null;
  /** Where the bar is, nought to one, or null when there is no bar. */
  readonly progress: number | null;
  readonly action: PopupAction;
  readonly actionLabel: string;
  readonly onReady: OnReady;
  /** The key, and the words the control wears, both of them whole semitones. */
  readonly semitones: number;
  readonly keyLabel: string;
}

export interface PopupInput {
  /** The last report for this tab, or null when there is none. */
  readonly report: StatusReport | null;
  /** The active tab's address, or undefined when there is no tab. */
  readonly url: string | undefined;
  readonly onReady: OnReady;
  /** The remembered default, which is what to show with nothing running. */
  readonly key: number;
}

/** Schemes a tab capture can be started on at all. */
const CAPTURABLE = /^https?:$/u;

/** Where the panel and the delayed picture work, which is one site. */
const SUPPORTED_HOST = 'www.youtube.com';

function schemeOf(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

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

/**
 * Why this tab cannot be captured, or null when it can. Chrome refuses its own
 * pages and anything that is not a page, and there is no point offering a
 * button that is going to be refused.
 */
export function captureBlock(url: string | undefined): string | null {
  const scheme = schemeOf(url);
  if (scheme === null) {
    return 'there is no page here to capture';
  }
  return CAPTURABLE.test(scheme) ? null : `Chrome does not allow capturing ${scheme} pages`;
}

/**
 * What is missing on a page that can be captured but is not the one this was
 * written for. The audio works anywhere a tab plays something; the panel and
 * the delayed picture are drawn over YouTube's player and nobody else's.
 */
export function pageNote(url: string | undefined): string | null {
  const host = hostOf(url);
  if (host === null || host === SUPPORTED_HOST || host.startsWith('localhost')) {
    return null;
  }
  return 'the on-page panel and the delayed picture only work on YouTube';
}

export function popupView(input: PopupInput): PopupView {
  const report = input.report;
  const onReady = report?.onReady ?? input.onReady;
  // The running capture over the remembered default, same as the setting: what
  // is playing now is what the person is looking at the popup to change.
  const semitones = clampKey(report?.semitones ?? input.key);
  const quiet = { progress: null, onReady, semitones, keyLabel: keyLabel(semitones) };

  if (report === null || report.status === 'idle') {
    const blocked = captureBlock(input.url);
    return {
      ...quiet,
      state: blocked === null ? 'idle' : 'unsupported',
      headline: blocked === null ? 'Not running' : 'Not here',
      detail:
        blocked ??
        pageNote(input.url) ??
        'Takes the vocal out of this tab and plays it back on a delay.',
      action: blocked === null ? 'start' : 'none',
      actionLabel: 'Start',
    };
  }

  if (report.status === 'priming') {
    const why = reprimeNote(report.reprime);
    const stage = prepareDetail(report);
    return {
      ...quiet,
      state: 'preparing',
      headline: 'Getting ready',
      progress: report.prepare?.fraction ?? 0,
      detail: why === null ? stage : `${why}. ${stage ?? ''}`.trim(),
      action: 'stop',
      actionLabel: 'Stop',
    };
  }

  if (report.status === 'paused') {
    return {
      ...quiet,
      state: 'paused',
      headline: 'Paused',
      detail: 'nothing lost; it carries on from here when the video does',
      action: 'stop',
      actionLabel: 'Stop',
    };
  }

  if (report.status === 'live') {
    return {
      ...quiet,
      state: 'live',
      headline: 'Live',
      detail: delayNote(report.delaySeconds, report.heldSeconds),
      action: 'stop',
      actionLabel: 'Stop',
    };
  }

  return {
    ...quiet,
    state: report.status === 'unsupported' ? 'unsupported' : 'error',
    headline: report.status === 'unsupported' ? 'This machine cannot do it live' : 'It went wrong',
    detail: report.reason ?? 'no reason given',
    action: 'stop',
    actionLabel: 'Stop',
  };
}

/** The two choices, in the words the radio buttons wear. */
export const ON_READY_CHOICES: readonly {
  readonly value: OnReady;
  readonly label: string;
}[] = [
  { value: 'restart', label: 'Restart from where I started, with a fade' },
  { value: 'continue', label: 'Keep playing the original, then switch (jumps back about 18 s)' },
];
