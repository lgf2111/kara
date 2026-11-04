import { ON_READY_CHOICES, popupView, type PopupView } from './popup/popup-view.ts';
import {
  packet,
  STATUS_KEY,
  type Request,
  type StatusReport,
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
 * two pieces of storage, drawing, and three event listeners.
 *
 * The state it shows is the last status report, which the service worker
 * leaves in `chrome.storage.session` as it routes it. A popup cannot have been
 * listening when the report went past — it did not exist — so it reads the
 * last one and then follows `chrome.storage.onChanged`, which is a push: the
 * progress bar moves on its own, four times a second, with nobody polling
 * anything.
 */

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

let tabId: number | null = null;
let url: string | undefined;
let report: StatusReport | null = null;
let onReady: OnReady = DEFAULT_SETTINGS.onReady;
/** A start that has been asked for and not yet answered. */
let starting = false;
let failure: string | null = null;

const radios = new Map<OnReady, HTMLInputElement>();

function send(body: Request): void {
  chrome.runtime.sendMessage(packet('background', body, tabId)).catch(() => undefined);
}

function view(): PopupView {
  return popupView({ report, url, onReady });
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
      // The offscreen document watches the same key, so a capture already
      // running picks this up without being told.
      writeSettings({ onReady: choice.value }).catch(() => undefined);
    });
  }
}

/** The stored report, if it belongs to the tab this popup was opened over. */
function take(stored: unknown): void {
  const value = stored as StoredStatus | undefined;
  report = value !== undefined && value.tabId === tabId ? value.report : null;
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

action.addEventListener('click', () => {
  if (view().action === 'stop') {
    send({ type: 'request-stop' });
    report = null;
    draw();
    return;
  }
  void start();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, STATUS_KEY)) {
    take(changes[STATUS_KEY]?.newValue);
    draw();
  }
  if (area === 'sync' && Object.hasOwn(changes, SETTINGS_KEY)) {
    onReady = parseSettings(changes[SETTINGS_KEY]?.newValue).onReady;
    draw();
  }
});

async function open(): Promise<void> {
  buildChoices();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  url = tab?.url;
  onReady = (await readSettings()).onReady;
  take((await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY]);
  draw();
}

open().catch((cause: unknown) => {
  failure = reasonText(cause);
  draw();
});
