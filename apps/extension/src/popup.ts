import { canNudge, KEY_DEFAULT, nudgeKey } from './audio/key.ts';
import { debugReportText } from './debug-report.ts';
import { ON_READY_CHOICES, popupView, type PopupView } from './popup/popup-view.ts';
import {
  DEBUG_KEY,
  packet,
  STATUS_KEY,
  type Command,
  type PipelineDebug,
  type Request,
  type StatusReport,
  type StoredDebug,
  type StoredStatus,
} from './protocol.ts';
import { reasonText } from './reason.ts';
import { DEFAULT_SETTINGS, SETTINGS_KEY, parseSettings, type OnReady } from './settings.ts';
import { readSettings, writeSettings } from './settings-store.ts';
import { mediaStreamId } from './tab-capture.ts';

/**
 * The toolbar popup: the click that starts a capture, and the state of one.
 *
 * It is here because of where Chrome puts the user gesture.
 * `chrome.tabCapture.getMediaStreamId` is granted off the back of a click in
 * one of the extension's own contexts, and the moment the action has a popup,
 * `chrome.action.onClicked` stops firing — so this is the only place left that
 * can ask for a stream id. It asks, and hands the id to the service worker,
 * which owns the offscreen document the audio lives in.
 *
 * Plain DOM, no framework, and every decision about what to say is in
 * `popup/popup-view.ts` where it can be tested. What is left here is reading
 * two pieces of storage, drawing, and the listeners.
 *
 * The state it shows is the last status report, which the service worker
 * leaves in `chrome.storage.session` as it routes it. A popup cannot have been
 * listening when the report went past — it did not exist — so it reads the
 * last one and then follows `chrome.storage.onChanged`, which is a push: the
 * progress bar moves on its own, four times a second, with nobody polling
 * anything.
 */

/** How often the event log is fetched while the popup is open, in ms. */
const DEBUG_TICK_MS = 2000;

function need<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`the popup has no ${selector}`);
  }
  return found;
}

const headline = need<HTMLParagraphElement>('#headline');
const detail = need<HTMLParagraphElement>('#detail');
const bar = need<HTMLProgressElement>('#bar');
const action = need<HTMLButtonElement>('#action');
const onReadyBox = need<HTMLFieldSetElement>('#on-ready');
const keyValue = need<HTMLSpanElement>('#key-value');
const keyDown = need<HTMLButtonElement>('#key-down');
const keyUp = need<HTMLButtonElement>('#key-up');
const keyClear = need<HTMLButtonElement>('#key-clear');
const copyDebug = need<HTMLButtonElement>('#copy-debug');
const copyNote = need<HTMLParagraphElement>('#copy-note');
const debugDump = need<HTMLTextAreaElement>('#debug-dump');

let tabId: number | null = null;
let url: string | undefined;
let report: StatusReport | null = null;
let onReady: OnReady = DEFAULT_SETTINGS.onReady;
/** The remembered default, until a report says what is actually playing. */
let key = DEFAULT_SETTINGS.key;
/** A start that has been asked for and not yet answered. */
let starting = false;
let failure: string | null = null;
/** The event log as the offscreen document last sent it, or null for none. */
let pipeline: PipelineDebug | null = null;

const radios = new Map<OnReady, HTMLInputElement>();

function send(body: Request): void {
  chrome.runtime.sendMessage(packet('background', body, tabId)).catch(() => undefined);
}

/**
 * Straight to the audio, with no relay: a runtime message already reaches
 * every extension context, and the envelope is what stops the wrong one
 * acting on it.
 */
function command(body: Command): void {
  chrome.runtime.sendMessage(packet('offscreen', body, tabId)).catch(() => undefined);
}

function view(): PopupView {
  return popupView({ report, url, onReady, key });
}

function draw(): void {
  const shown = view();
  headline.textContent = starting ? 'Starting…' : shown.headline;
  detail.textContent = failure ?? shown.detail;
  detail.hidden = detail.textContent === '';
  bar.hidden = shown.progress === null;
  if (shown.progress !== null) {
    bar.value = Math.round(shown.progress * 100);
  }
  action.textContent = shown.actionLabel;
  action.disabled = shown.action === 'none' || starting;
  for (const [value, radio] of radios) {
    radio.checked = value === shown.onReady;
  }
  keyValue.textContent = shown.keyLabel;
  keyDown.disabled = !canNudge(shown.semitones, -1);
  keyUp.disabled = !canNudge(shown.semitones, 1);
  keyClear.hidden = shown.semitones === KEY_DEFAULT;
}

/**
 * The key, in two places at once: the capture that is playing, by command, and
 * the remembered default, by storage.
 *
 * Both, because the popup is where a decision rather than a nudge is made. The
 * command is sent rather than left to the offscreen document's storage watcher
 * on purpose — the panel in the page can move the key too, without touching
 * the default, and a watcher pushing the stored value would undo that.
 */
function setKey(semitones: number): void {
  key = semitones;
  if (report !== null) {
    report = { ...report, semitones };
  }
  draw();
  command({ type: 'key', semitones });
  writeSettings({ key: semitones }).catch(() => undefined);
}

/** Two radios rather than a switch, because neither of them is the off one. */
function buildChoices(): void {
  for (const choice of ON_READY_CHOICES) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'on-ready';
    radio.value = choice.value;
    const words = document.createElement('span');
    words.textContent = choice.label;
    label.append(radio, words);
    onReadyBox.append(label);
    radios.set(choice.value, radio);
    radio.addEventListener('change', () => {
      if (!radio.checked) {
        return;
      }
      onReady = choice.value;
      draw();
      // The offscreen document watches the same storage key, so a capture
      // already running picks this up without being told.
      writeSettings({ onReady: choice.value }).catch(() => undefined);
    });
  }
}

/** The stored report, if it belongs to the tab this popup was opened over. */
function take(stored: unknown): void {
  const value = stored as StoredStatus | undefined;
  report = value !== undefined && value.tabId === tabId ? value.report : null;
}

function takeDebug(stored: unknown): void {
  const value = stored as StoredDebug | undefined;
  pipeline = value !== undefined && value.tabId === tabId ? value.pipeline : null;
}

/**
 * Asks the offscreen document for its event log, which comes back through the
 * service worker into session storage.
 *
 * Asked for in advance rather than on the button, because the clipboard is
 * only granted inside the click that pressed it: a copy that awaited a message
 * first would have lost the gesture by the time it had anything to copy.
 */
function askForDebug(): void {
  command({ type: 'debug' });
}

/**
 * Copies the report, redacted by `debug-report.ts`: an origin and no page
 * address beyond it, no video title, and nothing that is or was audio.
 */
function copyReport(): void {
  const text = debugReportText(
    {
      atMs: Date.now(),
      url,
      status: report,
      pipeline,
      version: chrome.runtime.getManifest().version,
    },
    navigator.userAgent,
  );
  copyNote.hidden = false;
  copyNote.textContent = 'Copied.';
  navigator.clipboard.writeText(text).catch(() => {
    // No clipboard, which some Chrome builds and policies answer with. The
    // text itself is the fallback: selected, so one keystroke takes it.
    copyNote.textContent = 'Select the text below and copy it.';
    debugDump.hidden = false;
    debugDump.value = text;
    debugDump.select();
  });
}

async function start(): Promise<void> {
  if (tabId === null) {
    return;
  }
  starting = true;
  failure = null;
  draw();
  try {
    // First, and before any await: the stream id is only granted off the back
    // of this click.
    const streamId = await mediaStreamId(tabId);
    send({ type: 'request-start', streamId, tabId });
  } catch (cause) {
    failure = reasonText(cause);
  } finally {
    starting = false;
    draw();
  }
}

keyDown.addEventListener('click', () => {
  setKey(nudgeKey(view().semitones, -1));
});

keyUp.addEventListener('click', () => {
  setKey(nudgeKey(view().semitones, 1));
});

keyClear.addEventListener('click', () => {
  setKey(KEY_DEFAULT);
});

action.addEventListener('click', () => {
  if (view().action === 'stop') {
    send({ type: 'request-stop' });
    report = null;
    draw();
    return;
  }
  void start();
});

copyDebug.addEventListener('click', copyReport);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, STATUS_KEY)) {
    take(changes[STATUS_KEY]?.newValue);
    draw();
  }
  if (area === 'session' && Object.hasOwn(changes, DEBUG_KEY)) {
    takeDebug(changes[DEBUG_KEY]?.newValue);
  }
  if (area === 'sync' && Object.hasOwn(changes, SETTINGS_KEY)) {
    const settings = parseSettings(changes[SETTINGS_KEY]?.newValue);
    onReady = settings.onReady;
    key = settings.key;
    draw();
  }
});

async function open(): Promise<void> {
  buildChoices();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  url = tab?.url;
  const settings = await readSettings();
  onReady = settings.onReady;
  key = settings.key;
  take((await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY]);
  takeDebug((await chrome.storage.session.get(DEBUG_KEY))[DEBUG_KEY]);
  draw();
  // And keep it fresh while this window is open, so the button always has
  // something current to copy.
  askForDebug();
  setInterval(askForDebug, DEBUG_TICK_MS);
}

open().catch((cause: unknown) => {
  failure = reasonText(cause);
  draw();
});
