import {
  DEBUG_KEY,
  IDLE_REPORT,
  packet,
  packetFor,
  STATUS_KEY,
  type PipelineDebug,
  type Report,
  type Status,
  type StatusReport,
  type StoredDebug,
  type StoredStatus,
  type StreamInfo,
} from './protocol.ts';
import { readDuetConfig, watchDuetConfig } from './duet-store.ts';
import { reasonText } from './reason.ts';
import { readSettings, watchSettings } from './settings-store.ts';
import { currentVideoId } from './stream/player.ts';

/**
 * The service worker: the tab, the offscreen document, and the routing.
 *
 * It holds the three things only it can hold. The tab, because `chrome.tabs`
 * exists nowhere else, so a report that has to reach the page has to come
 * through here. The offscreen document's existence, because creating one is a
 * service worker's job. And the audio stream the page reported, so that a
 * start asked for later has something to work with.
 *
 * What it no longer holds is the user gesture: there is no tab capture to
 * grant any more, so a start is a start whoever asked — the popup's button or
 * the panel in the page. The popup stays because it is the one place a person
 * can find the state of the session without a video playing.
 *
 * It holds no audio and no state worth losing. A Manifest V3 service worker is
 * killed whenever Chrome feels like it, including while the offscreen document
 * is still playing, so which tab the session belongs to lives in
 * `chrome.storage.session`
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
/**
 * `WORKERS`, not `AUDIO_PLAYBACK`, and the difference is the whole session.
 *
 * Chrome closes an offscreen document created with `AUDIO_PLAYBACK` thirty
 * seconds after it stops making sound. Preparing is minutes of silence by
 * design — the video is still the sound being heard — so that reason would
 * kill a session in the middle of the model load. Every other reason is
 * lifetime-free, and this one is honest: the document owns the separation
 * worker as well as the audio context.
 *
 * `USER_MEDIA` is there for the microphone desk. A microphone is only opened
 * when a person asks for monitoring, recording or practice, and has already
 * granted it from the popup; the document itself makes no request until then.
 * All three share one stream. The reasons keep the document alive for the
 * session rather than tying it to sound or to a device.
 */
const OFFSCREEN_REASONS = ['WORKERS', 'USER_MEDIA', 'BLOBS'] as const;
const JUSTIFICATION =
  'Reading, separating and playing a video audio track needs fetch, an ' +
  'AudioContext and a dedicated worker; the microphone desk and pitch practice ' +
  'need user media, and a finished recording becomes a Blob URL for the ' +
  'service worker to download. A service worker has none of these.';

const SESSION_KEY = 'kara.session';

/**
 * Where the page's audio stream is left, per tab and per video.
 *
 * The MAIN world script reports the stream of whatever video the page is
 * playing. It can report the next video before the address bar has caught up
 * with the click, and a late answer for the previous video can arrive after
 * it. Neither should decide what a later start uses, so each stream is filed
 * under the video it belongs to: a start asks for the video in the address
 * bar and gets exactly that one. It is a few hundred bytes of address, never
 * audio.
 *
 * One key per tab as well, because a YouTube tab in the background is still a
 * page with a video on it, and its stream must not replace the one belonging
 * to the tab somebody is looking at.
 */
const STREAM_PREFIX = 'kara.stream.';

function streamPrefix(tabId: number): string {
  return `${STREAM_PREFIX}${String(tabId)}.`;
}

function streamKey(tabId: number, videoId: string): string {
  return `${streamPrefix(tabId)}${videoId}`;
}

interface StoredStream {
  readonly tabId: number;
  readonly stream: StreamInfo;
}

interface Session {
  readonly tabId: number;
  /** The video the running session belongs to, when it can be known. */
  readonly videoId: string | null;
}

const BADGE: Readonly<Record<Status, string>> = {
  idle: '',
  preparing: '...',
  ready: '♪',
  paused: '||',
  unsupported: '!',
  error: '!',
};

const TITLE: Readonly<Record<Status, string>> = {
  idle: 'Kara: separate this video',
  preparing: 'Kara: reading and separating',
  ready: 'Kara: ready — toggle the vocal',
  paused: 'Kara: paused with the video',
  unsupported: 'Kara: this machine cannot do it',
  error: 'Kara: something went wrong',
};

async function session(): Promise<Session | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const value = stored[SESSION_KEY] as Partial<Session> | undefined;
  if (typeof value?.tabId !== 'number') {
    return null;
  }
  return {
    tabId: value.tabId,
    videoId: typeof value.videoId === 'string' ? value.videoId : null,
  };
}

async function remember(value: Session | null): Promise<void> {
  if (value === null) {
    await chrome.storage.session.remove(SESSION_KEY);
    return;
  }
  await chrome.storage.session.set({ [SESSION_KEY]: value });
}

async function rememberedStream(tabId: number, videoId: string): Promise<StreamInfo | null> {
  const key = streamKey(tabId, videoId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key] as Partial<StoredStream> | undefined;
  if (value === undefined || value.tabId !== tabId || typeof value.stream !== 'object') {
    return null;
  }
  const stream = value.stream;
  if (
    stream.videoId !== videoId ||
    typeof stream.url !== 'string' ||
    !stream.url.startsWith('https://') ||
    typeof stream.mimeType !== 'string'
  ) {
    return null;
  }
  return stream;
}

function keepStream(tabId: number, stream: StreamInfo): void {
  const stored: StoredStream = { tabId, stream };
  chrome.storage.session.set({ [streamKey(tabId, stream.videoId)]: stored }).catch(() => undefined);
}

/**
 * Forgets every stream a tab has reported, which is what closing it means.
 *
 * A video key is left behind when the tab moves on, on purpose: the next
 * video's stream may already be here, and a navigation that turns out to be
 * the same video must find its address again.
 */
async function forgetStreams(tabId: number): Promise<void> {
  const prefix = streamPrefix(tabId);
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(prefix));
  if (keys.length > 0) {
    await chrome.storage.session.remove(keys);
  }
}

function keepStatus(report: StatusReport, tabId: number | null): void {
  const stored: StoredStatus = { tabId, report };
  chrome.storage.session.set({ [STATUS_KEY]: stored }).catch(() => undefined);
}

function keepDebug(pipeline: PipelineDebug, tabId: number | null): void {
  const stored: StoredDebug = { tabId, pipeline };
  chrome.storage.session.set({ [DEBUG_KEY]: stored }).catch(() => undefined);
}

function send(message: unknown): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function offscreenOpen(): Promise<boolean> {
  // `chrome.offscreen.hasDocument()` is Chrome 150+. The manifest promises
  // 116, and `runtime.getContexts` has been there since 116.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PAGE)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await offscreenOpen()) {
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PAGE,
      reasons: [...OFFSCREEN_REASONS],
      justification: JUSTIFICATION,
    });
  } catch (cause) {
    // Two starts in quick succession race here, and one document is all that
    // was wanted anyway.
    if (!(await offscreenOpen())) {
      throw cause;
    }
  }
}

async function show(status: Status, tabId: number | null): Promise<void> {
  const title = TITLE[status];
  const text = BADGE[status];
  try {
    if (tabId === null) {
      await chrome.action.setTitle({ title });
      await chrome.action.setBadgeText({ text });
      return;
    }
    await chrome.action.setTitle({ tabId, title });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // The tab closed between the report and the label, so there is no badge to
    // set; that is not worth an unhandled rejection.
  }
}

async function stop(): Promise<void> {
  const active = await session();
  // Wait for the offscreen document to finish stopping. A take being recorded
  // is flushed and handed to the downloader in that window; closing the
  // document first would cut the file off at its last chunk.
  const stopping = active?.tabId ?? null;
  try {
    await Promise.race([
      chrome.runtime.sendMessage(packet('offscreen', { type: 'stop' }, stopping)),
      new Promise<void>((resolve) => {
        // A start still in preparation is queued ahead of the stop. Waiting
        // for it to finish would hold the document open for no reason; the
        // recording can only exist after a start has returned.
        setTimeout(resolve, 3000);
      }),
    ]);
  } catch {
    // The document may already be gone. Closing it below is the backstop.
  }
  await remember(null);
  if (await offscreenOpen()) {
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
 * Starts a session on one tab, stopping whatever was running first.
 *
 * One at a time, because the model only fits on the GPU once. The stream
 * comes from the page's own report, which the service worker has been
 * keeping; without one there is nothing to start, and the panel is told so.
 */
async function start(tabId: number, stream: StreamInfo): Promise<void> {
  const active = await session();
  if (active !== null && active.tabId !== tabId) {
    await stop();
  }
  await ensureOffscreen();
  await remember({ tabId, videoId: stream.videoId });
  await show('preparing', tabId);
  // The offscreen document cannot read storage, so it is told the settings.
  const [settings, duet] = await Promise.all([readSettings(), readDuetConfig()]);
  send(packet('offscreen', { type: 'start', stream, tabId, key: settings.key, duet }, tabId));
}

async function asked(tabId: number | null): Promise<void> {
  if (tabId === null) {
    return;
  }
  let here: string | null;
  try {
    here = currentVideoId((await chrome.tabs.get(tabId)).url ?? '');
  } catch {
    // The tab closed between the request and the read, so there is nothing to
    // start on it and nothing worth reporting either.
    return;
  }
  // The address bar is the authority on which video is on screen. The stream
  // is filed under its own video id, so a report that arrived before the
  // address caught up is waiting here, and one from an earlier video is not
  // even looked at. A tab whose address names no video has none to start.
  const stream = here === null ? null : await rememberedStream(tabId, here);
  if (stream === null) {
    const report: StatusReport = {
      ...IDLE_REPORT,
      status: 'error',
      reason: 'the page has not shared its audio yet; let the video start playing and try again',
    };
    keepStatus(report, tabId);
    chrome.tabs.sendMessage(tabId, packet('tab', report, tabId)).catch(() => undefined);
    return;
  }
  try {
    await start(tabId, stream);
  } catch (cause) {
    await show('idle', tabId);
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
  if (report.type === 'debug-log') {
    // Left where a popup can read it synchronously: its copy button has to
    // answer inside the click that pressed it, so what it copies has to be
    // something it already has. Not sent on to the tab — the page has no use
    // for it and no business holding one.
    keepDebug(report.pipeline, tabId);
    return;
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
  if (
    body.type === 'status' ||
    body.type === 'metrics' ||
    body.type === 'debug-log' ||
    body.type === 'practice-analysis' ||
    body.type === 'practice-live' ||
    body.type === 'song-analysis'
  ) {
    relay(body, received.tabId);
  }
  if (body.type === 'request-start') {
    void asked(body.tabId ?? sender.tab?.id ?? null);
  }
  if (body.type === 'request-stream') {
    // The tab is whoever sent it: a stream belongs to the page that found it.
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      keepStream(tabId, body.stream);
    }
  }
  if (body.type === 'request-download') {
    // The offscreen document cannot call `chrome.downloads`, so it hands the
    // finished take over as an object URL and this context saves it. Only a
    // local blob is accepted: this route must never become a fetch of
    // something on the network. The URL is revoked by the offscreen document
    // after the download has started.
    if (!body.url.startsWith('blob:')) {
      return false;
    }
    chrome.downloads
      .download({
        url: body.url,
        filename: body.filename,
        saveAs: false,
        conflictAction: 'uniquify',
      })
      .catch((cause: unknown) => {
        console.error('kara: the recording could not be saved:', reasonText(cause));
      });
  }
  if (body.type === 'request-stop') {
    stop().catch((cause: unknown) => {
      console.error('kara:', reasonText(cause));
    });
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetStreams(tabId);
  void (async () => {
    if ((await session())?.tabId === tabId) {
      await stop();
    }
  })();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  void (async () => {
    const active = await session();
    if (active === null || active.tabId !== tabId || change.url === undefined) {
      return;
    }
    // YouTube rewrites its own address while the same video is on screen — a
    // playlist parameter, a timestamp, the end of a redirect. That is not a
    // new song, and stopping on it would throw away a session the person is
    // listening to. Only a session whose own video is no longer in the address
    // bar ends here.
    const here = currentVideoId(change.url);
    if (here !== null && active.videoId === here) {
      return;
    }
    // A session belongs to one video, not to a tab: YouTube swapping one
    // video for another is a whole new song and needs a whole new analysis,
    // so any other navigation ends the session. Leaving the site is the same
    // thing by another route.
    send(packet('offscreen', { type: 'stop' }, tabId));
    void stop();
  })();
});

watchSettings((settings) => {
  session()
    .then((active) => {
      if (active !== null) {
        send(packet('offscreen', { type: 'key', semitones: settings.key }, active.tabId));
      }
    })
    .catch(() => undefined);
});

/**
 * A Save in the popup reaches a session that is already running, so the next
 * Duet press uses the new URL and token without a restart. The token is never
 * logged; only the offscreen document receives it.
 */
watchDuetConfig((config) => {
  session()
    .then((active) => {
      if (active !== null) {
        send(packet('offscreen', { type: 'duet-config', config }, active.tabId));
      }
    })
    .catch(() => undefined);
});
