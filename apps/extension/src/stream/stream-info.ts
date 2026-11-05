import {
  isVideoId,
  pickStream,
  playerResponses,
  unwrapPlayer,
  VISIONOS,
  visionosBody,
  type PlayerResponse,
  type StreamInfo,
} from './player.ts';

/**
 * The page's own world, reporting the audio stream of the video being watched.
 *
 * This runs in the MAIN world, which is the only place that can see how the
 * page gets its media. The video element's `src` is a blob URL behind which
 * the real stream address lives in the player response the page fetched.
 * There is no extension API for it and no clean page API either, so this file
 * watches for the player response itself, in the three places YouTube leaves
 * one:
 *
 * - `window.ytInitialPlayerResponse`, the script tag the watch page is seeded
 *   with, intercepted with a setter at `document_start` so the assignment is
 *   seen however the page later rewrites it;
 * - `XMLHttpRequest` and `fetch` responses from the `/youtubei/v1/player`
 *   endpoint, which is how the page asks for a video on the first load; and
 * - the same responses from `/youtubei/v1/get_watch`, which is what the
 *   current page asks for when a video is opened without a reload. That
 *   answer is an array of envelopes with a `playerResponse` inside one of
 *   them; without watching it, clicking a related video would leave the
 *   extension with no stream until the page was refreshed.
 *
 * A player response is not enough any more. The web player may be in YouTube's
 * SABR experiment, where `adaptiveFormats` carry no URLs and the page streams
 * through a session protocol this extension does not speak. So the page asks
 * YouTube once more, as VISIONOS — same origin, same cookies, a client that
 * still returns ordinary signed URLs — and posts that answer. The report is
 * still just a URL, a mime type and a length. Nothing is decided here: not
 * whether the video is an ad, not whether the extension already has this
 * stream, not whether the URL is one it may fetch. The content script checks
 * the shape, the service worker files it under the video it belongs to, and
 * the offscreen document downloads it.
 *
 * It is deliberately dumb about the page. The page can spoof a `postMessage`
 * to the same effect, and nothing is gained by trying to be clever about it:
 * the extension treats a reported stream the way it treats everything else the
 * page says, by checking it against what it knows.
 */

/** The tag both halves of the page bridge recognise. Matches `content.ts`. */
const TAG = 'kara/1';

/** How long to wait for `ytcfg` to exist on a page that is still booting. */
const CONFIG_WAIT_MS = 8000;

/** How long a resolved stream is kept before a later response may refresh it. */
const RESOLVE_MEMORY_MS = 60_000;

/** The config the VISIONOS request needs, read from the page's own `ytcfg`. */
interface PageConfig {
  readonly apiKey: string;
  readonly visitorData?: string;
  readonly hl: string;
  readonly gl: string;
}

interface Ytcfg {
  readonly get?: (key: string) => unknown;
  readonly data_?: Record<string, unknown>;
}

interface ClientContext {
  readonly visitorData?: unknown;
  readonly hl?: unknown;
  readonly gl?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function cfgText(cfg: Ytcfg | undefined, key: string): string | undefined {
  return text(cfg?.get?.(key)) ?? text(cfg?.data_?.[key]);
}

/** The page's own API key and visitor data, or null while it is still booting. */
function pageConfig(): PageConfig | null {
  const cfg = (window as unknown as { ytcfg?: Ytcfg }).ytcfg;
  const apiKey = cfgText(cfg, 'INNERTUBE_API_KEY');
  if (apiKey === undefined) {
    return null;
  }
  const context =
    (cfg?.get?.('INNERTUBE_CONTEXT') ?? cfg?.data_?.['INNERTUBE_CONTEXT']) as
      | { readonly client?: ClientContext }
      | undefined;
  const client = context?.client;
  const visitorData = text(client?.visitorData) ?? cfgText(cfg, 'VISITOR_DATA');
  return {
    apiKey,
    ...(visitorData !== undefined ? { visitorData } : {}),
    hl: text(client?.hl) ?? cfgText(cfg, 'HL') ?? 'en',
    gl: text(client?.gl) ?? cfgText(cfg, 'GL') ?? 'US',
  };
}

async function waitForConfig(): Promise<PageConfig | null> {
  const deadline = Date.now() + CONFIG_WAIT_MS;
  for (;;) {
    const found = pageConfig();
    if (found !== null) {
      return found;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) {
    return;
  }
  warned.add(message);
  console.warn(`kara: ${message}`);
}

/**
 * Asks YouTube for the same video as VISIONOS, on the page's behalf.
 *
 * This is the same request a television or headset client makes: the API key
 * and visitor data come from the page, the request is same-origin, and the
 * page's cookies go with it. What comes back is a player response with signed
 * media URLs instead of a SABR session, which is what a whole-track download
 * can use.
 */
async function visionosStream(videoId: string): Promise<StreamInfo | null> {
  const config = await waitForConfig();
  if (config === null) {
    warnOnce('could not read the page config, so the audio was not requested');
    return null;
  }
  let response: Response;
  try {
    response = await fetch(
      `/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(VISIONOS.clientId),
          'X-YouTube-Client-Version': VISIONOS.version,
          'X-Goog-Api-Format-Version': '2',
          ...(config.visitorData !== undefined
            ? { 'X-Goog-Visitor-Id': config.visitorData }
            : {}),
        },
        body: JSON.stringify(
          visionosBody({
            videoId,
            ...(config.visitorData !== undefined ? { visitorData: config.visitorData } : {}),
            hl: config.hl,
            gl: config.gl,
          }),
        ),
      },
    );
  } catch {
    warnOnce('the page could not ask YouTube for the audio');
    return null;
  }
  if (!response.ok) {
    warnOnce('YouTube refused the audio request');
    return null;
  }
  let body: PlayerResponse;
  try {
    body = (await response.json()) as PlayerResponse;
  } catch {
    warnOnce('YouTube sent something that was not a player response');
    return null;
  }
  if (body.playabilityStatus?.status !== 'OK') {
    warnOnce('YouTube would not play this video for the audio request');
    return null;
  }
  const found = pickStream(body);
  if (found === null || found.videoId !== videoId) {
    warnOnce('YouTube had no audio URL for this video');
    return null;
  }
  return found;
}

/** Where each video's stream came from, so a late fallback cannot undo a VISIONOS answer. */
const sources = new Map<string, 'page' | 'visionos'>();
const resolving = new Map<string, Promise<StreamInfo | null>>();
let last: StreamInfo | null = null;

function post(stream: StreamInfo, from: 'page' | 'visionos'): void {
  if (from === 'page' && sources.get(stream.videoId) === 'visionos') {
    return;
  }
  if (last !== null && last.url === stream.url) {
    return;
  }
  last = stream;
  sources.set(stream.videoId, from);
  window.postMessage({ kara: TAG, stream }, '*');
}

/**
 * Repeats the last stream when the content script asks for it.
 *
 * This script runs at `document_start` and can resolve a stream before the
 * content script, which runs at `document_idle`, has installed its listener.
 * The message would be lost, and there is no second player response to wait
 * for on a page whose only one was the SABR-toting seed. So the content script
 * says it is ready, and the answer is repeated once.
 */
function repost(): void {
  if (last !== null) {
    window.postMessage({ kara: TAG, stream: last }, '*');
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const message = event.data as { readonly kara?: unknown; readonly request?: unknown } | null;
  if (
    message === null ||
    typeof message !== 'object' ||
    message.kara !== TAG ||
    message.request !== 'stream'
  ) {
    return;
  }
  repost();
});

/**
 * Starts one VISIONOS request per video, and reports the page's own stream
 * first if it has one.
 *
 * The page's stream goes out immediately so that a person who presses the
 * button before the second request finishes has something to start with. The
 * VISIONOS answer replaces it as soon as it lands, because it is the one that
 * is not a SABR session and not a format the web player has already moved
 * past. A failed VISIONOS request leaves the page's stream in place.
 */
function resolve(videoId: string, fallback: StreamInfo | null): void {
  if (fallback !== null) {
    post(fallback, 'page');
  }
  if (resolving.has(videoId)) {
    return;
  }
  const promise = visionosStream(videoId);
  resolving.set(videoId, promise);
  void promise
    .then((stream) => {
      if (stream !== null) {
        post(stream, 'visionos');
      }
    })
    .catch(() => undefined)
    .finally(() => {
      // A later player response for the same video may try again: the first
      // answer may have been refused, and the page may have been reloaded
      // into a different experiment since.
      setTimeout(() => {
        if (resolving.get(videoId) === promise) {
          resolving.delete(videoId);
        }
      }, RESOLVE_MEMORY_MS);
    });
}

/** Reads a player response, whatever carried it, and starts a resolve. */
function considerResponse(response: PlayerResponse): void {
  const videoId = response.videoDetails?.videoId;
  if (!isVideoId(videoId)) {
    return;
  }
  if (response.videoDetails?.isLive === true) {
    return;
  }
  resolve(videoId, pickStream(response));
}

/**
 * Considers whatever an innertube endpoint sent.
 *
 * `/youtubei/v1/player` sends the player response itself; `/get_watch` sends
 * an array of envelopes, one of which holds a `playerResponse`. Every one is
 * read, and the video id inside decides where the answer is filed. The page
 * may be a frame behind the address bar, so nothing here is dropped on the
 * strength of the current URL.
 */
function considerPayload(payload: unknown): void {
  for (const response of playerResponses(payload)) {
    considerResponse(response);
  }
}

/** Whether a request address is one that carries a player response. */
function isPlayerCall(url: string): boolean {
  return url.includes('/youtubei/v1/player') || url.includes('/youtubei/v1/get_watch');
}

/** Parses an intercepted body and considers its player response. */
function consider(url: string, body: string): void {
  if (!isPlayerCall(url) || body.length === 0) {
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return;
  }
  considerPayload(json);
}

/** Catches the seeded player response, whatever order the scripts run in. */
function watchInitial(): void {
  const holder = window as unknown as { ytInitialPlayerResponse?: PlayerResponse };
  const descriptor = Object.getOwnPropertyDescriptor(holder, 'ytInitialPlayerResponse');
  if (descriptor !== undefined && descriptor.configurable === false) {
    // Someone less polite took it first. The request watchers below still
    // catch everything after the first video, and the first is often there.
    return;
  }
  let value = descriptor?.value as PlayerResponse | undefined;
  Object.defineProperty(holder, 'ytInitialPlayerResponse', {
    configurable: true,
    get: () => value,
    set: (next: PlayerResponse) => {
      value = next;
      considerResponse(unwrapPlayer(next));
    },
  });
  if (value !== undefined) {
    considerResponse(unwrapPlayer(value));
  }
}

/** Catches the player calls the page makes for every video after the first. */
function watchXhr(): void {
  const original = XMLHttpRequest.prototype.open;
  const callOpen = original as unknown as (
    method: string,
    url: string | URL,
    ...extra: unknown[]
  ) => void;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...extra: unknown[]
  ): void {
    this.addEventListener('load', () => {
      if (this.responseType === '' || this.responseType === 'text') {
        consider(String(url), this.responseText);
      }
    });
    callOpen.call(this, method, url, ...extra);
  } as typeof XMLHttpRequest.prototype.open;
}

/** The same watcher for the day the page's calls move to `fetch`. */
function watchFetch(): void {
  const original = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const asked =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const result = original.call(this, input, init);
    if (isPlayerCall(asked)) {
      result
        .then(async (response) => {
          if (!response.ok) {
            return;
          }
          consider(asked, await response.clone().text());
        })
        .catch(() => undefined);
    }
    return result;
  };
}

watchInitial();
watchXhr();
watchFetch();
