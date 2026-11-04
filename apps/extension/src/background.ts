import { packet, packetFor, type Report, type Status } from './protocol.ts';
import { reasonText } from './reason.ts';

/**
 * The service worker: the click, the tab, and the routing between them.
 *
 * It holds the three things only it can hold. The user gesture, because
 * `chrome.tabCapture.getMediaStreamId` is only granted off the back of one and
 * `chrome.action.onClicked` is where one arrives. The tab, because
 * `chrome.tabs` exists nowhere else, so a report that has to reach the page
 * has to come through here. And the offscreen document's existence, because
 * creating one is a service worker's job.
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
  /** Where the tab was when it was captured, so a navigation can be judged. */
  readonly origin: string;
}

const BADGE: Readonly<Record<Status, string>> = {
  idle: '',
  priming: '...',
  live: 'on',
  unsupported: '!',
  error: '!',
};

const TITLE: Readonly<Record<Status, string>> = {
  idle: 'Kara: capture this tab',
  priming: 'Kara: getting ready',
  live: 'Kara: live',
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

/**
 * The callback form of `getMediaStreamId`, named here rather than taken from
 * the typings: every Chrome with this API has it, the promise form arrived
 * later, and a refusal lands in `lastError` either way.
 */
interface StreamIdApi {
  getMediaStreamId: (
    options: { readonly targetTabId: number },
    callback: (streamId: string) => void,
  ) => void;
}

function mediaStreamId(targetTabId: number): Promise<string> {
  const api = chrome.tabCapture as unknown as StreamIdApi;
  return new Promise((resolve, reject) => {
    api.getMediaStreamId({ targetTabId }, (streamId) => {
      const failure = chrome.runtime.lastError;
      if (failure !== undefined) {
        reject(new Error(failure.message ?? 'this tab could not be captured'));
        return;
      }
      resolve(streamId);
    });
  });
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
}

async function start(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) {
    throw new Error('that tab has no id, so it cannot be captured');
  }
  // First, and before any await that could outlive the gesture: the stream id
  // is only granted off the back of the click.
  const streamId = await mediaStreamId(tabId);
  await ensureOffscreen();
  await remember({ tabId, origin: new URL(tab.url ?? 'about:blank').origin });
  await show('priming', tabId);
  send(packet('offscreen', { type: 'start', streamId, tabId }, tabId));
}

async function toggle(tab: chrome.tabs.Tab): Promise<void> {
  const active = await captured();
  if (active !== null) {
    // One capture at a time, because the model only fits on the GPU once. A
    // second press on the tab already running is how a person stops it.
    await stop();
    if (active.tabId === tab.id) {
      return;
    }
  }
  await start(tab);
}

function relay(report: Report, tabId: number | null): void {
  if (report.type === 'status') {
    void show(report.status, tabId);
  }
  if (tabId !== null) {
    chrome.tabs.sendMessage(tabId, packet('tab', report, tabId)).catch(() => undefined);
  }
}

chrome.action.onClicked.addListener((tab) => {
  toggle(tab).catch((cause: unknown) => {
    void show('error', tab.id ?? null);
    console.error('kara:', reasonText(cause));
  });
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  const received = packetFor('background', message);
  if (received === null) {
    return false;
  }
  const body = received.body;
  if (body.type === 'status' || body.type === 'metrics') {
    relay(body, received.tabId);
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
    // reset. Leaving the site altogether is a stop.
    if (new URL(change.url).origin === active.origin) {
      send(packet('offscreen', { type: 'reset', reason: 'navigation' }, tabId));
      return;
    }
    await stop();
  })();
});
