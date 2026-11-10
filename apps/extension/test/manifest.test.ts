import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildManifest } from '../src/manifest.ts';

describe('buildManifest', () => {
  it('asks for the permissions the audio side needs and no more', () => {
    expect(buildManifest().permissions).toEqual([
      'offscreen',
      'storage',
      'audioCapture',
      'downloads',
    ]);
  });

  it('is on youtube.com plus the local duet helper by default', () => {
    const manifest = buildManifest();

    expect(manifest.host_permissions).toEqual([
      'https://www.youtube.com/*',
      'https://*.googlevideo.com/*',
      'http://127.0.0.1/*',
    ]);
    expect(manifest.manifest_version).toBe(3);
  });

  it('adds localhost only when the build asks for it', () => {
    const local = buildManifest({ localhost: true });

    expect(local.host_permissions).toEqual([
      'https://www.youtube.com/*',
      'http://localhost/*',
      'https://*.googlevideo.com/*',
      'http://127.0.0.1/*',
    ]);
    expect(buildManifest({ localhost: false }).host_permissions).toEqual([
      'https://www.youtube.com/*',
      'https://*.googlevideo.com/*',
      'http://127.0.0.1/*',
    ]);
  });

  it('drops the loopback helper in the stable edition', () => {
    const stable = buildManifest({ stable: true });

    expect(stable.host_permissions).toEqual([
      'https://www.youtube.com/*',
      'https://*.googlevideo.com/*',
    ]);
    expect(stable.permissions).toEqual(
      buildManifest().permissions,
    );
  });

  it('matches the content script to the same sites as the host permissions', () => {
    expect(buildManifest().content_scripts[0]?.matches).toEqual(['https://www.youtube.com/*']);
    expect(buildManifest({ localhost: true }).content_scripts[0]?.matches).toEqual([
      'https://www.youtube.com/*',
      'http://localhost/*',
    ]);
  });

  it('points both icon sets at files that exist', () => {
    const manifest = buildManifest();
    const icons = new URL('../public/', import.meta.url);

    for (const size of ['16', '32', '48', '128'] as const) {
      const path = manifest.icons[size];

      expect(manifest.action.default_icon[size]).toBe(path);
      expect(path).toBe(`icons/icon${size}.png`);
      expect(existsSync(fileURLToPath(new URL(path, icons)))).toBe(true);
    }
  });

  it('runs the stream grabber in the page world before the page can load', () => {
    const grabber = buildManifest().content_scripts[1];

    expect(grabber?.js).toEqual(['stream-info.js']);
    expect(grabber?.run_at).toBe('document_start');
    expect(grabber?.world).toBe('MAIN');
    expect(grabber?.all_frames).toBe(false);
  });

  it('lets the extension fetch its own audio without a remote origin anywhere', () => {
    const policy = buildManifest().content_security_policy.extension_pages;

    expect(policy).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  });

  it('may save the finished recording, because only it can', () => {
    expect(buildManifest().permissions).toContain('downloads');
  });
});
