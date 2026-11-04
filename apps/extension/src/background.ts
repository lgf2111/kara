import {
  IDLE_REPORT,
  packet,
  packetFor,
  STATUS_KEY,
  type Report,
  type Status,
  type StatusReport,
  type StoredStatus,
} from './protocol.ts';
import { reasonText } from './reason.ts';
import { mediaStreamId } from './tab-capture.ts';

/**
 * The service worker: the tab, the offscreen document, and the routing.
 *
 * It holds the three things only it can hold. The tab, because `chrome.tabs`
 * exists nowhere else, so a report that has to reach the page has to come
 * through here. The offscreen document's existence, because creating one is a
 * service worker's job. And the last status report, in session storage, so
 * that a popup opening cold has something to show before the next one arrives.
 *
 * What it no longer holds is the user gesture. `chrome.tabCapture` is granted
 * off the back of a click in an extension context, and since the action has a
 * popup, that click lands in the popup rather than in `chrome.action.onClicked`
 * — which, with a popup set, never fires at all. So the popup fetches the
 * stream id itself and passes it here with the request to start.
 *
 * It holds no audio and no state worth losing. A Manifest V3 service worker is
 * killed whenever Chrome feels like it, including while the offscreen document
 * is still playing, so which tab is captured lives in `chrome.storage.session`
 * rather than in a variable here.
 *
 * Routing is asymmetric, which is worth knowing before looking for the other
 * half. A `chrome.runtime` message from a content script already reaches every
 * extension context, the offscreen document included, so a command travelling
 * towards the audio needs no help: the envelope's address is what keeps the
 * wrong context from acting on it. A report travelling back does need help,
 * because reaching a tab means `chrome.tabs.sendMessage`, and that is here.
 */

const OFFSCREEN_PAGE = 'offscreen.html';
const JUSTIFICATION =
  "Separating the captured tab's audio and playing it back on a delay needs " +
  'getUserMedia and an AudioContext, neither of which a service worker has.';

/** Chrome takes the enum's string values; the typings insist on the enum. */
const REASONS = ['USER_MEDIA', 'AUDIO_PLAYBACK'] as unknown as chrome.offscreen.Reason[];

const CAPTURED_KEY = 'kara.captured';

interface Captured {
  readonly tabId: number;
  /**
   * Where the tab was when it was captured, so a navigation can be judged, or
   * empty when it could not be read. A service worker only sees a tab's URL
   * where it has a host permission or an `activeTab` grant, and a capture it
   * cannot place is a capture no navigation should be allowed to stop.
   */
  readonly origin: string;
}

/** The origin of an address, or empty for one nobody can read. */
function originOf(url: string | undefined): string {
  if (url === undefined) {
    return '';
  }
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

const BADGE: Readonly<Record<Status, string>> = {
  idle: '',
  priming: '...',
  live: 'on',
  paused: '||',
  unsupported: '!',
  error: '!',
};

const TITLE: Readonly<Record<Status, string>> = {
  idle: 'Kara: capture this tab',
  priming: 'Kara: getting ready',
  live: 'Kara: live',
  paused: 'Kara: paused with the page',
  unsupported: 'Kara: this machine cannot do it live',
  error: 'Kara: something went wrong',
};

async function captured(): Promise<Captured | null> {
  const stored = await chrome.storage.session.get(CAPTURED_KEY);
  const value = stored[CAPTURED_KEY] as Partial<Captured> | undefined;
  return typeof value?.tabId === 'number' && typeof value.origin === 'string'
    ? { tabId: value.tabId, origin: value.origin }
    : null;
}

async function remember(value: Captured | null): Promise<void> {
  if (value === null) {
    await chrome.storage.session.remove(CAPTURED_KEY);
    return;
  }
  await chrome.storage.session.set({ [CAPTURED_KEY]: value });
}

function keepStatus(report: StatusReport, tabId: number | null): void {
  const stored: StoredStatus = { tabId, report };
  chrome.storage.session.set({ [STATUS_KEY]: stored }).catch(() => undefined);
}

function send(message: unknown): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PAGE,
      reasons: REASONS,
      justification: JUSTIFICATION,
    });
  } catch (cause) {
    // Two clicks in quick succession race here, and one document is all that
    // was wanted anyway.
    if (!(await chrome.offscreen.hasDocument())) {
      throw cause;
    }
  }
}

async function show(status: Status, tabId: number | null): Promise<void> {
  const title = TITLE[status];
  const text = BADGE[status];
  if (tabId === null) {
    await chrome.action.setTitle({ title });
    await chrome.action.setBadgeText({ text });
    return;
  }
  await chrome.action.setTitle({ tabId, title });
  await chrome.action.setBadgeText({ tabId, text });
}

async function stop(): Promise<void> {
  const active = await captured();
  // Best effort, so the tracks are released promptly. Closing the document is
  // what actually guarantees it.
  send(packet('offscreen', { type: 'stop' }, active?.tabId ?? null));
  await remember(null);
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
  await show('idle', active?.tabId ?? null);
  // The offscreen document says this for itself when it stops cleanly, but it
  // is being closed in the same breath, so neither the panel in the page nor a
  // popup can be left waiting to hear it.
  keepStatus(IDLE_REPORT, active?.tabId ?? null);
  if (active !== null) {
    chrome.tabs
      .sendMessage(active.tabId, packet('tab', IDLE_REPORT, active.tabId))
      .catch(() => undefined);
  }
}

/**
 * Starts a capture of one tab, stopping whatever was being captured first.
 *
 * One at a time, because the model only fits on the GPU once. The stream id
 * comes from the popup when the popup asked, because that is where the gesture
 * was; when the page asked there is none, and trying here is what produces the
 * refusal the panel turns into a hint.
 */
async function start(tabId: number, offered: string | null): Promise<void> {
  const active = await captured();
  if (active !== null && active.tabId !== tabId) {
    await stop();
  }
  const streamId = offered ?? (await mediaStreamId(tabId));
  await ensureOffscreen();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await remember({ tabId, origin: originOf(tab?.url) });
  await show('priming', tabId);
  send(packet('offscreen', { type: 'start', streamId, tabId }, tabId));
}

/**
 * A start somebody asked for: the popup, with an id, or the panel in the page,
 * without one.
 *
 * A click inside a page is a gesture for the page, not for the extension, so
 * the panel's own button cannot produce a stream id. This tries anyway and,
 * when Chrome refuses, tells the tab to point the person at the toolbar.
 * Trying rather than assuming means the panel's button starts working by
 * itself on the day Chrome allows it, and the refusal costs one rejected
 * promise.
 */
async function asked(tabId: number | undefined, streamId: string | null): Promise<void> {
  if (tabId === undefined) {
    return;
  }
  try {
    await start(tabId, streamId);
  } catch (cause) {
    await show('idle', tabId);
    if (streamId === null) {
      chrome.tabs
        .sendMessage(tabId, packet('tab', { type: 'hint', hint: 'toolbar' }, tabId))
        .catch(() => undefined);
      return;
    }
    // The popup had a gesture and it still failed, which is worth saying.
    const report: StatusReport = { ...IDLE_REPORT, status: 'error', reason: reasonText(cause) };
    keepStatus(report, tabId);
    chrome.tabs.sendMessage(tabId, packet('tab', report, tabId)).catch(() => undefined);
  }
}

function relay(report: Report, tabId: number | null): void {
  if (report.type === 'status') {
    void show(report.status, tabId);
    keepStatus(report, tabId);
  }
  if (tabId !== null) {
    chrome.tabs.sendMessage(tabId, packet('tab', report, tabId)).catch(() => undefined);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const received = packetFor('background', message);
  if (received === null) {
    return false;
  }
  const body = received.body;
  if (body.type === 'status' || body.type === 'metrics') {
    relay(body, received.tabId);
  }
  if (body.type === 'request-start') {
    void asked(body.tabId ?? sender.tab?.id, body.streamId);
  }
  if (body.type === 'request-stop') {
    stop().catch((cause: unknown) => {
      console.error('kara:', reasonText(cause));
    });
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    if ((await captured())?.tabId === tabId) {
      await stop();
    }
  })();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  void (async () => {
    const active = await captured();
    if (active === null || active.tabId !== tabId || change.url === undefined) {
      return;
    }
    // A capture belongs to a tab, not to a page, so it survives YouTube
    // swapping one video for another: that is a new timeline, which is a
    // reset. Leaving the site altogether is a stop — unless the origin could
    // not be read when the capture started, in which case there is nothing to
    // compare against and throwing the capture away would be a guess.
    if (active.origin === '' || originOf(change.url) === active.origin) {
      send(packet('offscreen', { type: 'reset', reason: 'navigation' }, tabId));
      return;
    }
    await stop();
  })();
});
