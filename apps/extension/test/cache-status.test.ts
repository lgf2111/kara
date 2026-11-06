import { describe, expect, it } from 'vitest';

import {
  cacheStatusLabel,
  formatBytes,
  normaliseCacheStatus,
} from '../src/cache/status.ts';
import { panelView } from '../src/content/panel-view.ts';
import {
  cacheUsageView,
  popupView,
} from '../src/popup/popup-view.ts';
import { report } from './report.ts';

describe('cache status', () => {
  it('reads a status and bounds its detail', () => {
    expect(
      normaliseCacheStatus({
        state: 'hit',
        bytes: 14_800_000.9,
        detail: '  Loaded\nfrom cache.  ',
      }),
    ).toEqual({
      state: 'hit',
      bytes: 14_800_000,
      detail: 'Loaded from cache.',
    });
    expect(
      normaliseCacheStatus({
        state: 'writing',
        bytes: -1,
        detail: 'x'.repeat(500),
      })?.detail?.length,
    ).toBe(120);
  });

  it('rejects a status that is not one', () => {
    expect(normaliseCacheStatus(null)).toBeNull();
    expect(normaliseCacheStatus('hit')).toBeNull();
    expect(normaliseCacheStatus({ state: 'playing', bytes: 1 })).toBeNull();
    expect(normaliseCacheStatus([])).toBeNull();
  });

  it('says each state in the panel words', () => {
    expect(cacheStatusLabel({ state: 'checking', bytes: null })).toBe('Checking cache…');
    expect(cacheStatusLabel({ state: 'hit', bytes: 14_800_000 })).toBe('Cached: 14.8 MB');
    expect(cacheStatusLabel({ state: 'miss', bytes: null })).toBe('Not cached');
    expect(cacheStatusLabel({ state: 'writing', bytes: null })).toBe('Saving cache…');
    expect(cacheStatusLabel({ state: 'ready', bytes: 1_500 })).toBe('Cached: 2 KB');
    expect(cacheStatusLabel({ state: 'error', bytes: null })).toBe('Cache unavailable');
    expect(cacheStatusLabel(null)).toBeNull();
  });

  it('formats bytes the way the popup already does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1_500)).toBe('2 KB');
    expect(formatBytes(14_800_000)).toBe('14.8 MB');
    expect(formatBytes(1_073_741_824)).toBe('1.1 GB');
  });
});

describe('the panel cache row', () => {
  it('is absent before a session has looked', () => {
    const view = panelView({ report: report({ status: 'ready' }) });
    expect(view.cacheLabel).toBeNull();
    expect(view.cacheDetail).toBeNull();
  });

  it('shows a hit, a write and a failure in one row', () => {
    const hit = panelView({
      report: report({
        status: 'ready',
        cache: { state: 'hit', bytes: 14_800_000, detail: 'Loaded from cache.' },
      }),
    });
    const writing = panelView({
      report: report({
        status: 'preparing',
        cache: { state: 'writing', bytes: null, detail: 'Saving cache…' },
      }),
    });
    const failed = panelView({
      report: report({
        status: 'ready',
        cache: { state: 'error', bytes: null, detail: 'Cache unavailable.' },
      }),
    });

    expect(hit.cacheLabel).toBe('Cached: 14.8 MB');
    expect(hit.cacheState).toBe('hit');
    expect(hit.cacheDetail).toBe('Loaded from cache.');
    // A hit is an ordinary ready session for every control: only the source
    // of the stems changed.
    expect(hit.controls).toBe(true);
    expect(hit.duetCanStart).toBe(true);
    expect(hit.practiceCanStart).toBe(true);
    expect(writing.cacheLabel).toBe('Saving cache…');
    expect(failed.cacheLabel).toBe('Cache unavailable');
    expect(failed.cacheState).toBe('error');
  });
});

describe('the popup cache section', () => {
  it('shows usage and offers to clear it', () => {
    const view = cacheUsageView({
      bytes: 14_800_000,
      count: 1,
      limitBytes: 1024 * 1024 * 1024,
    });

    expect(view.label).toBe('Cached: 14.8 MB · 1 song');
    expect(view.detail).toContain('Scores and settings are not touched');
    expect(view.clearDisabled).toBe(false);
    expect(view.clearLabel).toBe('Clear cache');
  });

  it('refuses to clear while a session runs or while it is clearing', () => {
    const usage = { bytes: 10, count: 1, limitBytes: 100 };

    expect(cacheUsageView(usage, { running: true }).clearDisabled).toBe(true);
    expect(cacheUsageView(usage, { running: true }).detail).toContain('Stop the session');
    expect(cacheUsageView(usage, { busy: true }).clearLabel).toBe('Clearing…');
    expect(cacheUsageView(usage, { busy: true }).clearDisabled).toBe(true);
  });

  it('has nothing to clear and no cache when the store cannot answer', () => {
    const empty = cacheUsageView({ bytes: 0, count: 0, limitBytes: 100 });
    const missing = cacheUsageView(null);

    expect(empty.label).toBe('Cached: 0 B');
    expect(empty.clearDisabled).toBe(true);
    expect(missing.label).toBe('Cache unavailable.');
    expect(missing.clearDisabled).toBe(true);
    expect(missing.clearLabel).toBe('Clear cache');
  });

  it('puts the session cache state in diagnostics', () => {
    const view = popupView({
      report: report({
        status: 'ready',
        cache: { state: 'hit', bytes: 14_800_000, detail: null },
      }),
      url: 'https://www.youtube.com/watch?v=abc123',
      key: 0,
    });
    const rows = view.diagnostics?.groups.flatMap((group) => group.rows) ?? [];

    expect(rows).toContainEqual({ label: 'Cache', value: 'Cached: 14.8 MB' });
  });
});
