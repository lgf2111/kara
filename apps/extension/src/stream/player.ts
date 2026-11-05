/**
 * The player response, read for the one thing this extension needs: an audio
 * URL it can download in full.
 *
 * YouTube's web player no longer hands out per-format MP4/WebM addresses when
 * it is in its SABR experiment: the response has a `serverAbrStreamingUrl` and
 * every `adaptiveFormats` entry has no `url`, only a format id. The page plays
 * through SABR, which is a session protocol the player speaks and this
 * extension does not. So the page is asked a second time, as VISIONOS, which
 * still returns ordinary signed URLs. This file is the part of that answer
 * both worlds can agree on, and the pure functions that read it.
 *
 * The shape is deliberately narrower than YouTube's. Anything not listed here
 * is ignored, so a new field cannot change what is selected by accident.
 */

/** One adaptive or muxed format, the fields of it this extension reads. */
export interface StreamFormat {
  readonly itag?: number;
  readonly mimeType?: string;
  readonly bitrate?: number;
  readonly contentLength?: string;
  readonly url?: string;
}

/** The slice of a player response this extension reads. */
export interface PlayerResponse {
  readonly videoDetails?: {
    readonly videoId?: string;
    readonly isLive?: boolean;
  };
  readonly playabilityStatus?: {
    readonly status?: string;
    readonly reason?: string;
  };
  readonly streamingData?: {
    readonly adaptiveFormats?: readonly StreamFormat[];
    readonly formats?: readonly StreamFormat[];
    readonly serverAbrStreamingUrl?: string;
    readonly hlsManifestUrl?: string;
  };
}

/** An audio stream found in a player response, as the page reports it. */
export interface StreamInfo {
  readonly videoId: string;
  readonly url: string;
  readonly mimeType: string;
  readonly bitrate?: number;
  readonly contentLength?: string;
}

/** Video ids are eleven characters of URL-safe alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;

/** Whether a string is shaped like a YouTube video id. */
export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

/**
 * The video a watch page is showing, or null on a page that is not one.
 *
 * Ads and recommendations are not the video; the player response for either
 * has a `videoId` and the page's address does not change for it. Checking this
 * before resolving a stream is what keeps an ad from becoming the song.
 */
export function currentVideoId(address: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return null;
  }
  if (parsed.hostname === 'youtu.be') {
    const short = parsed.pathname.slice(1).split('/')[0] ?? '';
    return VIDEO_ID.test(short) ? short : null;
  }
  const watched = parsed.searchParams.get('v');
  if (watched !== null && VIDEO_ID.test(watched)) {
    return watched;
  }
  const named = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/u.exec(parsed.pathname);
  return named?.[1] ?? null;
}

/** Whether a mime type is an audio track on its own. */
function audioOnly(format: StreamFormat): boolean {
  return typeof format.mimeType === 'string' && format.mimeType.startsWith('audio/');
}

/**
 * Whether a muxed format carries audio in its codec list.
 *
 * The muxed fallback matters because some clients return itag 18 with a URL
 * while every adaptive format is SABR-gated. Decoding a muxed MP4 still gives
 * `decodeAudioData` its audio track; what it costs is the video bytes, which
 * is why it is second choice.
 */
function muxedWithAudio(format: StreamFormat): boolean {
  if (typeof format.mimeType !== 'string' || !format.mimeType.startsWith('video/')) {
    return false;
  }
  return /(?:mp4a|opus|vorbis|ac-3|ec-3)/iu.test(format.mimeType);
}

function withUrl(
  formats: readonly StreamFormat[] | undefined,
  wanted: (format: StreamFormat) => boolean,
): (StreamFormat & { url: string; mimeType: string })[] {
  if (formats === undefined) {
    return [];
  }
  return formats.filter(
    (format): format is StreamFormat & { url: string; mimeType: string } =>
      typeof format.url === 'string' &&
      format.url.startsWith('https://') &&
      typeof format.mimeType === 'string' &&
      wanted(format),
  );
}

/** The highest-bitrate format in a list, or null. */
function loudest(
  formats: (StreamFormat & { url: string; mimeType: string })[],
): (StreamFormat & { url: string; mimeType: string }) | null {
  let best: (StreamFormat & { url: string; mimeType: string }) | null = null;
  for (const format of formats) {
    if (best === null || (format.bitrate ?? 0) > (best.bitrate ?? 0)) {
      best = format;
    }
  }
  return best;
}

/**
 * The best stream in a player response, or null.
 *
 * Audio-only first, and a muxed format only if there is no audio-only URL.
 * Live streams are refused on purpose: a live URL is a window into a stream
 * that is still being made, not a track with a beginning and an end, and the
 * whole-track design cannot hold one.
 */
export function pickStream(response: PlayerResponse): StreamInfo | null {
  const videoId = response.videoDetails?.videoId;
  if (!isVideoId(videoId)) {
    return null;
  }
  if (response.videoDetails?.isLive === true) {
    return null;
  }
  const streaming = response.streamingData;
  if (streaming === undefined) {
    return null;
  }
  const adaptive = streaming.adaptiveFormats ?? [];
  const best =
    loudest(withUrl(adaptive, audioOnly)) ??
    loudest(withUrl(streaming.formats, audioOnly)) ??
    loudest(withUrl(streaming.formats, muxedWithAudio));
  if (best === null) {
    return null;
  }
  return {
    videoId,
    url: best.url,
    mimeType: best.mimeType,
    ...(best.bitrate !== undefined ? { bitrate: best.bitrate } : {}),
    ...(best.contentLength !== undefined ? { contentLength: best.contentLength } : {}),
  };
}

/**
 * The player response inside an innertube envelope, or the envelope itself
 * when it is already one.
 */
export function unwrapPlayer(payload: PlayerResponse): PlayerResponse {
  const nested = (payload as unknown as { playerResponse?: PlayerResponse }).playerResponse;
  return nested ?? payload;
}

/**
 * Every player response an endpoint sent.
 *
 * `/youtubei/v1/player` sends one, wrapped or bare. `/youtubei/v1/get_watch`,
 * which is what the current page asks for when a video is opened without a
 * reload, sends an array of envelopes with the player response inside one of
 * them. Both shapes are read the same way; the video id inside decides which
 * one matters.
 */
/** Whether an object has any of the fields a player response is read for. */
function looksLikePlayer(value: unknown): value is PlayerResponse {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as PlayerResponse;
  return (
    candidate.videoDetails !== undefined ||
    candidate.streamingData !== undefined ||
    candidate.playabilityStatus !== undefined
  );
}

export function playerResponses(payload: unknown): PlayerResponse[] {
  if (Array.isArray(payload)) {
    const found: PlayerResponse[] = [];
    for (const entry of payload) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const nested = (entry as { playerResponse?: PlayerResponse }).playerResponse;
      const player = nested ?? (entry as PlayerResponse);
      if (looksLikePlayer(player)) {
        found.push(player);
      }
    }
    return found;
  }
  if (payload !== null && typeof payload === 'object') {
    const player = unwrapPlayer(payload as PlayerResponse);
    return looksLikePlayer(player) ? [player] : [];
  }
  return [];
}

/**
 * The VISIONOS client, which is the one current YouTube still answers with
 * plain signed media URLs rather than SABR.
 *
 * These strings are part of the request, not a preference: the player endpoint
 * picks its delivery path by the client identity. `buildVisionosRequest` keeps
 * them together so there is one place to change when YouTube moves again.
 */
export const VISIONOS = {
  name: 'VISIONOS',
  version: '1.02',
  clientId: 101,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
} as const;

export interface VisionosOptions {
  readonly videoId: string;
  readonly visitorData?: string;
  readonly hl?: string;
  readonly gl?: string;
}

/** The JSON body of the player request that asks for a VISIONOS answer. */
export function visionosBody(options: VisionosOptions): unknown {
  return {
    context: {
      client: {
        clientName: VISIONOS.name,
        clientVersion: VISIONOS.version,
        deviceMake: VISIONOS.deviceMake,
        deviceModel: VISIONOS.deviceModel,
        userAgent: VISIONOS.userAgent,
        osName: VISIONOS.osName,
        osVersion: VISIONOS.osVersion,
        hl: options.hl ?? 'en',
        gl: options.gl ?? 'US',
        ...(options.visitorData !== undefined && options.visitorData !== ''
          ? { visitorData: options.visitorData }
          : {}),
      },
    },
    videoId: options.videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
}
