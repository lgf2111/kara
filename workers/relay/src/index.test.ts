import { describe, expect, it } from 'vitest';

import { handleRequest } from './index';

describe('GET /health', () => {
  it('reports the service', async () => {
    const response = handleRequest(new Request('https://relay.example/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: 'kara-relay', status: 'ok' });
  });

  it('answers HEAD as well', () => {
    expect(handleRequest(new Request('https://relay.example/health', { method: 'HEAD' })).status).toBe(200);
  });

  it('rejects other methods', () => {
    const response = handleRequest(new Request('https://relay.example/health', { method: 'DELETE' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('media cannot reach the relay', () => {
  it('refuses a request with a body, whatever the route', () => {
    for (const path of ['/health', '/signal', '/rooms/ABCD', '/']) {
      const response = handleRequest(
        new Request(`https://relay.example${path}`, { method: 'POST', body: 'anything' }),
      );
      expect(response.status, path).toBe(415);
    }
  });

  it('refuses an audio or video content type even with no body', () => {
    for (const contentType of ['audio/mpeg', 'video/mp4', 'image/png']) {
      const response = handleRequest(
        new Request('https://relay.example/health', { headers: { 'content-type': contentType } }),
      );
      expect(response.status, contentType).toBe(415);
    }
  });
});

describe('unknown routes', () => {
  it('are not found', () => {
    expect(handleRequest(new Request('https://relay.example/')).status).toBe(404);
    expect(handleRequest(new Request('https://relay.example/upload')).status).toBe(404);
  });
});
