/**
 * Kara's relay. It will carry WebRTC signalling and room codes (M5) and nothing
 * else: peers exchange audio directly, so media must never reach this Worker.
 *
 * Today it answers `GET /health` and refuses everything else. The refusal is
 * the point. Signalling will arrive over a WebSocket upgrade, which carries no
 * request body, so rejecting bodies outright costs nothing and removes the
 * only path by which a file could be uploaded here, deliberately or by mistake.
 */

/** No bindings yet. Room state arrives with the signalling work in M5. */
export type Env = Record<string, never>;

const MEDIA_CONTENT_TYPE = /^(?:audio|video|image)\//iu;

function json(payload: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function handleRequest(request: Request): Response {
  const contentType = request.headers.get('content-type') ?? '';
  if (request.body !== null || MEDIA_CONTENT_TYPE.test(contentType)) {
    return json({ error: 'this relay accepts no request bodies and no media' }, 415);
  }

  const { pathname } = new URL(request.url);
  if (pathname !== '/health') {
    return json({ error: 'not found' }, 404);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  }

  return json({ service: 'kara-relay', status: 'ok' });
}

const handler: ExportedHandler<Env> = {
  fetch(request) {
    return handleRequest(request);
  },
};

export default handler;
