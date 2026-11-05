import { describe, expect, it } from 'vitest';

import {
  currentVideoId,
  isVideoId,
  pickStream,
  playerResponses,
  unwrapPlayer,
  VISIONOS,
  visionosBody,
  type PlayerResponse,
} from '../src/stream/player.ts';

const AUDIO_ONLY = {
  itag: 251,
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 136_544,
  contentLength: '3433755',
  url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=251',
};

const LOWER_AUDIO = {
  itag: 250,
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 65_508,
  url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=250',
};

const MUXED = {
  itag: 18,
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  bitrate: 444_226,
  url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=18',
};

function response(overrides: Partial<PlayerResponse> = {}): PlayerResponse {
  return {
    videoDetails: { videoId: 'dQw4w9WgXcQ' },
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [AUDIO_ONLY, LOWER_AUDIO] },
    ...overrides,
  };
}

describe('isVideoId', () => {
  it('accepts exactly eleven URL-safe characters', () => {
    expect(isVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isVideoId('EKaQmeVZurp')).toBe(true);
    expect(isVideoId('___________')).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isVideoId('short')).toBe(false);
    expect(isVideoId('dQw4w9WgXcQx')).toBe(false);
    expect(isVideoId('dQw4w9WgXc!')).toBe(false);
    expect(isVideoId(undefined)).toBe(false);
    expect(isVideoId(12345678901)).toBe(false);
  });
});

describe('currentVideoId', () => {
  it('reads a watch page', () => {
    expect(currentVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(currentVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('reads a short link', () => {
    expect(currentVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
  });

  it('reads shorts, live and embed addresses', () => {
    expect(currentVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(currentVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(currentVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('answers null when the address does not name a video', () => {
    expect(currentVideoId('https://www.youtube.com/')).toBeNull();
    expect(currentVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(currentVideoId('https://youtu.be/')).toBeNull();
    expect(currentVideoId('not a url')).toBeNull();
  });
});

describe('pickStream', () => {
  it('takes the highest-bitrate audio-only format', () => {
    expect(pickStream(response())).toEqual({
      videoId: 'dQw4w9WgXcQ',
      url: AUDIO_ONLY.url,
      mimeType: AUDIO_ONLY.mimeType,
      bitrate: AUDIO_ONLY.bitrate,
      contentLength: AUDIO_ONLY.contentLength,
    });
  });

  it('prefers a quiet audio track to a loud muxed one', () => {
    const found = pickStream(
      response({ streamingData: { adaptiveFormats: [], formats: [MUXED, AUDIO_ONLY] } }),
    );

    expect(found?.url).toBe(AUDIO_ONLY.url);
  });

  it('falls back to a muxed format when no audio-only URL is offered', () => {
    const found = pickStream(response({ streamingData: { formats: [MUXED] } }));

    expect(found?.url).toBe(MUXED.url);
    expect(found?.mimeType).toBe(MUXED.mimeType);
  });

  it('does not fall back to a video-only format', () => {
    const silent = { ...MUXED, mimeType: 'video/mp4; codecs="avc1.42001E"' };

    expect(pickStream(response({ streamingData: { formats: [silent] } }))).toBeNull();
  });

  it('ignores formats without a direct URL, which is what SABR looks like', () => {
    const sabr = {
      itag: 251,
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: 136_544,
      contentLength: '3433755',
    };

    expect(pickStream(response({ streamingData: { adaptiveFormats: [sabr] } }))).toBeNull();
  });

  it('ignores a URL that is not https', () => {
    const insecure = { ...AUDIO_ONLY, url: 'http://example.com/audio' };

    expect(pickStream(response({ streamingData: { adaptiveFormats: [insecure] } }))).toBeNull();
  });

  it('refuses a live stream, which has no end to hold', () => {
    expect(
      pickStream(response({ videoDetails: { videoId: 'dQw4w9WgXcQ', isLive: true } })),
    ).toBeNull();
  });

  it('refuses a response with no usable video id', () => {
    expect(pickStream(response({ videoDetails: {} }))).toBeNull();
    expect(pickStream(response({ videoDetails: { videoId: 'short' } }))).toBeNull();
  });

  it('refuses a response with no streaming data at all', () => {
    expect(pickStream({ videoDetails: { videoId: 'dQw4w9WgXcQ' } })).toBeNull();
  });
});

describe('playerResponses', () => {
  it('reads a bare player response', () => {
    const player = response();

    expect(playerResponses(player)).toEqual([player]);
  });

  it('unwraps an envelope', () => {
    const player = response();

    expect(unwrapPlayer({ playerResponse: player } as PlayerResponse)).toBe(player);
    expect(playerResponses({ playerResponse: player })).toEqual([player]);
  });

  it('reads the array get_watch sends, one envelope at a time', () => {
    const player = response();

    expect(
      playerResponses([
        { responseContext: { serviceTrackingParams: [] } },
        { playerResponse: player },
        null,
        'not an object',
      ]),
    ).toEqual([player]);
  });

  it('has nothing to read from a body that is not an object', () => {
    expect(playerResponses(null)).toEqual([]);
    expect(playerResponses('a string')).toEqual([]);
    expect(playerResponses(42)).toEqual([]);
  });
});

describe('visionosBody', () => {
  it('asks as the VISIONOS client, by name and by version', () => {
    const body = visionosBody({ videoId: 'dQw4w9WgXcQ' }) as {
      context: { client: Record<string, unknown> };
      videoId: string;
    };

    expect(body.videoId).toBe('dQw4w9WgXcQ');
    expect(body.context.client.clientName).toBe(VISIONOS.name);
    expect(body.context.client.clientVersion).toBe(VISIONOS.version);
    expect(body.context.client.userAgent).toBe(VISIONOS.userAgent);
    expect(body.context.client.hl).toBe('en');
    expect(body.context.client.gl).toBe('US');
  });

  it('carries the page visitor data when there is some', () => {
    const body = visionosBody({
      videoId: 'dQw4w9WgXcQ',
      visitorData: 'CgtaLUlQNzBt',
      hl: 'de',
      gl: 'DE',
    }) as { context: { client: Record<string, unknown> } };

    expect(body.context.client.visitorData).toBe('CgtaLUlQNzBt');
    expect(body.context.client.hl).toBe('de');
    expect(body.context.client.gl).toBe('DE');
  });

  it('leaves the visitor data out rather than sending an empty one', () => {
    const body = visionosBody({ videoId: 'dQw4w9WgXcQ', visitorData: '' }) as {
      context: { client: Record<string, unknown> };
    };

    expect('visitorData' in body.context.client).toBe(false);
  });
});
