import { describe, expect, it } from 'vitest';

import { buildManifest } from '../src/manifest.ts';

describe('buildManifest', () => {
  it('asks for the five permissions the audio side needs and no more', () => {
    expect(buildManifest().permissions).toEqual([
      'tabCapture',
      'offscreen',
      'activeTab',
      'scripting',
      'storage',
    ]);
  });

  it('is on youtube.com and nowhere else by default', () => {
    const manifest = buildManifest();

    expect(manifest.host_permissions).toEqual(['https://www.youtube.com/*']);
    expect(manifest.manifest_version).toBe(3);
  });

  it('adds localhost only when the build asks for it', () => {
    const local = buildManifest({ localhost: true });

    expect(local.host_permissions).toEqual([
      'https://www.youtube.com/*',
      'http://localhost/*',
    ]);
    expect(buildManifest({ localhost: false }).host_permissions).toEqual([
      'https://www.youtube.com/*',
    ]);
  });

  it('matches the content script to the same sites as the host permissions', () => {
    for (const manifest of [buildManifest(), buildManifest({ localhost: true })]) {
      expect(manifest.content_scripts[0]?.matches).toEqual(manifest.host_permissions);
      expect(manifest.content_scripts[0]?.js).toEqual(['content.js']);
    }
  });

  it('allows the one thing the default policy forbids and the runtime needs', () => {
    const policy = buildManifest().content_security_policy.extension_pages;

    expect(policy).toContain("'wasm-unsafe-eval'");
    // No remote origin anywhere: everything is loaded from the packed files.
    expect(policy).not.toMatch(/https?:/u);
  });

  it('runs the service worker as a module and the content script as a script', () => {
    const manifest = buildManifest();

    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });
});
